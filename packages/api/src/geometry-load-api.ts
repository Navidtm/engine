import {
  type GeometryLoadErrorPayload,
  type MainToWorkerMessage,
  RUNTIME_PROTOCOL_VERSION,
  type WorkerToMainMessage,
} from "@lume/runtime";
import type { GeometryHandle } from "@lume/scene";

import type { EngineState, PendingGeometryLoad } from "./engine/state.js";
import { post } from "./engine/transport.js";
import type { GeometryLoadOptions, LoadApi } from "./engine/types.js";
import {
  type GeometryLoadReservation,
  publishGeometryLoadResource,
  reserveGeometryLoadResource,
  rollbackGeometryLoadResource,
} from "./resource-lifecycle.js";

type GeometryResultMessage = Extract<
  WorkerToMainMessage,
  { type: "geometry-ready" | "geometry-failed" }
>;

/** Stable public error for external geometry loading and cancellation. */
export class GeometryLoadError extends Error {
  override readonly name: "GeometryLoadError" | "AbortError";

  constructor(
    readonly code: GeometryLoadErrorPayload["code"],
    readonly stage: GeometryLoadErrorPayload["stage"],
    message: string,
    options: { readonly aborted?: boolean } = {},
  ) {
    super(message);
    this.name =
      options.aborted === true && code === "LUME_ASSET_ABORTED"
        ? "AbortError"
        : "GeometryLoadError";
  }
}

/** Creates the framework-neutral public loading facade for one engine. */
export function createGeometryLoadApi(
  state: EngineState,
  failEngine: (error: Error) => void,
): LoadApi {
  return {
    geometry(source, options = {}) {
      try {
        requireGeometryLoadReady(state);
        const signal = validateAbortSignal(options);
        if (signal?.aborted === true) throw abortedLoadError();
        if (state.geometryLimits === undefined) {
          throw new GeometryLoadError(
            "LUME_ASSET_BUDGET_EXCEEDED",
            "budget",
            "External geometry loading requires EngineConfig.geometryLimits.",
          );
        }
        const resolvedSource = resolveGeometrySource(source);
        const requestId = nextGeometryRequestId(state);
        const reservation = reserveGeometryLoadResource(state);
        return beginGeometryLoad(state, reservation, requestId, resolvedSource, signal, failEngine);
      } catch (error) {
        return Promise.reject(normalizeRequestError(error));
      }
    },
  };
}

/** Settles one correlated worker result; returns a fatal protocol error when mirrors diverge. */
export function handleGeometryLoadMessage(
  state: EngineState,
  message: GeometryResultMessage,
): Error | undefined {
  const pending = state.geometryLoads.get(message.requestId);
  if (pending === undefined) return undefined;
  if (message.protocolVersion !== RUNTIME_PROTOCOL_VERSION || message.handle !== pending.raw) {
    return new Error("Geometry load response violated protocol correlation.");
  }
  const reservation = pending as GeometryLoadReservation;
  if (message.type === "geometry-ready") {
    try {
      publishGeometryLoadResource(state, reservation);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
    state.geometryLoads.delete(message.requestId);
    pending.removeAbortListener();
    pending.resolve(pending.handle);
    return undefined;
  }
  state.geometryLoads.delete(message.requestId);
  pending.removeAbortListener();
  rollbackGeometryLoadResource(state, reservation, true);
  pending.reject(
    new GeometryLoadError(message.error.code, message.error.stage, message.error.message, {
      aborted: pending.abortRequested && message.error.code === "LUME_ASSET_ABORTED",
    }),
  );
  return undefined;
}

/** Rejects every in-flight public load when the owning engine terminates. */
export function rejectPendingGeometryLoads(state: EngineState, message: string): void {
  const error = new GeometryLoadError("LUME_ASSET_ABORTED", "lifecycle", message);
  for (const pending of state.geometryLoads.values()) {
    pending.removeAbortListener();
    pending.reject(error);
  }
  state.geometryLoads.clear();
}

function beginGeometryLoad(
  state: EngineState,
  reservation: GeometryLoadReservation,
  requestId: number,
  source: string,
  signal: AbortSignal | undefined,
  failEngine: (error: Error) => void,
): Promise<GeometryHandle> {
  let resolvePromise!: PendingGeometryLoad["resolve"];
  let rejectPromise!: PendingGeometryLoad["reject"];
  const promise = new Promise<typeof reservation.handle>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  let removeAbortListener = (): void => undefined;
  const pending: PendingGeometryLoad = {
    ...reservation,
    resolve: resolvePromise,
    reject: rejectPromise,
    removeAbortListener: () => removeAbortListener(),
    abortRequested: false,
  };
  if (signal !== undefined) {
    const onAbort = (): void => {
      if (state.geometryLoads.get(requestId) !== pending) return;
      pending.abortRequested = true;
      try {
        post(state, abortMessage(requestId, reservation.raw));
      } catch (error) {
        failEngine(error instanceof Error ? error : new Error(String(error)));
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  }
  state.geometryLoads.set(requestId, pending);
  try {
    post(state, {
      type: "load-geometry",
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      requestId,
      handle: reservation.raw,
      source,
    });
  } catch (error) {
    state.geometryLoads.delete(requestId);
    pending.removeAbortListener();
    rollbackGeometryLoadResource(state, reservation, false);
    const cause = error instanceof Error ? error : new Error(String(error));
    pending.reject(
      new GeometryLoadError(
        "LUME_ASSET_ABORTED",
        "lifecycle",
        "Worker communication failed before geometry loading could begin.",
      ),
    );
    failEngine(cause);
  }
  return promise;
}

function abortMessage(requestId: number, handle: number): MainToWorkerMessage {
  return {
    type: "abort-geometry-load",
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    requestId,
    handle,
  };
}

function validateAbortSignal(options: GeometryLoadOptions): AbortSignal | undefined {
  const signal = options.signal;
  if (signal === undefined) return undefined;
  if (
    typeof signal !== "object" ||
    typeof signal.aborted !== "boolean" ||
    typeof signal.addEventListener !== "function" ||
    typeof signal.removeEventListener !== "function"
  ) {
    throw new TypeError("GeometryLoadOptions.signal must be an AbortSignal.");
  }
  return signal;
}

function requireGeometryLoadReady(state: EngineState): void {
  if (state.status !== "ready" && state.status !== "running" && state.status !== "stopped") {
    throw new GeometryLoadError(
      "LUME_ASSET_ABORTED",
      "lifecycle",
      `Cannot load geometry while engine status is '${state.status}'.`,
    );
  }
}

function resolveGeometrySource(source: string | URL): string {
  if (typeof source !== "string" && !(source instanceof URL)) {
    throw new TypeError("Geometry source must be a string or URL.");
  }
  try {
    return new URL(source, document.baseURI).href;
  } catch (cause) {
    throw new GeometryLoadError(
      "LUME_ASSET_FORMAT",
      "request",
      cause instanceof Error
        ? `Invalid geometry source: ${cause.message}`
        : "Invalid geometry source.",
    );
  }
}

function nextGeometryRequestId(state: EngineState): number {
  if (!Number.isSafeInteger(state.nextGeometryRequest) || state.nextGeometryRequest <= 0) {
    throw new GeometryLoadError(
      "LUME_ASSET_CAPACITY_EXHAUSTED",
      "lifecycle",
      "Geometry request correlation capacity is exhausted.",
    );
  }
  return state.nextGeometryRequest++;
}

function normalizeRequestError(error: unknown): Error {
  if (error instanceof GeometryLoadError || error instanceof TypeError) return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "LUME_CAPACITY_EXHAUSTED"
  ) {
    return new GeometryLoadError(
      "LUME_ASSET_CAPACITY_EXHAUSTED",
      "request",
      "Geometry resource capacity is exhausted.",
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

function abortedLoadError(): GeometryLoadError {
  return new GeometryLoadError("LUME_ASSET_ABORTED", "lifecycle", "Geometry load was aborted.", {
    aborted: true,
  });
}
