import { AssetError, decodeGlbGeometry, isAssetError } from "@lume/assets";
import type { MeshRenderer } from "@lume/renderer";

import { defineRuntimeGeometryLimits, type RuntimeGeometryLimits } from "./geometry-limits.js";
import {
  type GeometryLoadErrorPayload,
  type MainToWorkerMessage,
  RUNTIME_PROTOCOL_VERSION,
  type WorkerToMainMessage,
} from "./protocol.js";
import type { GeometryLoadAttempt, ResourceCoordinator } from "./resource-coordinator.js";

type LoadMessage = Extract<MainToWorkerMessage, { type: "load-geometry" }>;
type AbortMessage = Extract<MainToWorkerMessage, { type: "abort-geometry-load" }>;

export interface GeometryLoader {
  load(message: LoadMessage): void;
  abort(message: AbortMessage): void;
  dispose(): void;
}

export interface GeometryLoaderDependencies {
  readonly coordinator: ResourceCoordinator;
  readonly limits: RuntimeGeometryLimits;
  readonly fetch: (source: string, init: RequestInit) => Promise<Response>;
  readonly acquireRenderer: (signal: AbortSignal) => Promise<MeshRenderer>;
  readonly postMessage: (message: WorkerToMainMessage) => void;
  readonly decode?: typeof decodeGlbGeometry;
}

/** Runs correlated fetch/decode/upload transactions outside the frame scheduler. */
export function createGeometryLoader(dependencies: GeometryLoaderDependencies): GeometryLoader {
  const limits = defineRuntimeGeometryLimits(dependencies.limits);
  const decode = dependencies.decode ?? decodeGlbGeometry;
  let disposed = false;

  const postFailure = (message: LoadMessage | AbortMessage, error: unknown): void => {
    dependencies.postMessage({
      type: "geometry-failed",
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      requestId: message.requestId,
      handle: message.handle,
      error: errorPayload(error),
    });
  };

  return {
    load(message) {
      if (message.protocolVersion !== RUNTIME_PROTOCOL_VERSION) {
        postFailure(
          message,
          new AssetError(
            "LUME_ASSET_UNSUPPORTED",
            "request",
            "Geometry load protocol version mismatch.",
          ),
        );
        return;
      }
      if (disposed) {
        postFailure(
          message,
          new AssetError("LUME_ASSET_ABORTED", "lifecycle", "Geometry loader is disposed."),
        );
        return;
      }
      let source: string;
      try {
        source = new URL(message.source).href;
      } catch {
        postFailure(
          message,
          new AssetError(
            "LUME_ASSET_FORMAT",
            "request",
            "Geometry source must be an absolute URL.",
          ),
        );
        return;
      }

      let attempt: GeometryLoadAttempt;
      try {
        attempt = dependencies.coordinator.beginGeometryLoad(message.requestId, message.handle);
      } catch (error) {
        postFailure(message, error);
        return;
      }
      void executeLoad(message, source, attempt, dependencies, limits, decode, () => disposed);
    },
    abort(message) {
      if (message.protocolVersion !== RUNTIME_PROTOCOL_VERSION) {
        postFailure(
          message,
          new AssetError(
            "LUME_ASSET_UNSUPPORTED",
            "request",
            "Geometry abort protocol version mismatch.",
          ),
        );
        return;
      }
      dependencies.coordinator.abortGeometryLoad(message.requestId);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      dependencies.coordinator.abortAllGeometryLoads();
    },
  };
}

async function executeLoad(
  message: LoadMessage,
  source: string,
  attempt: GeometryLoadAttempt,
  dependencies: GeometryLoaderDependencies,
  limits: Readonly<RuntimeGeometryLimits>,
  decode: typeof decodeGlbGeometry,
  isDisposed: () => boolean,
): Promise<void> {
  const startedAt = performance.now();
  let stage: "fetch" | "decode" | "upload" | "recovery" = "fetch";
  try {
    const fetchStartedAt = performance.now();
    const response = await dependencies.fetch(source, { signal: attempt.signal });
    assertCurrent(dependencies.coordinator, attempt);
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new AssetError(
        "LUME_ASSET_NETWORK",
        "fetch",
        `Geometry request failed with HTTP status ${response.status}.`,
      );
    }
    const encoded = await readGeometryResponse(
      response,
      limits.decode.maxEncodedBytes,
      attempt.signal,
    );
    const fetchReadMs = performance.now() - fetchStartedAt;
    assertCurrent(dependencies.coordinator, attempt);
    dependencies.coordinator.prepareGeometryDecode(attempt, encoded.byteLength);

    stage = "decode";
    await yieldColdPath(attempt.signal);
    assertCurrent(dependencies.coordinator, attempt);
    const decodeStartedAt = performance.now();
    const descriptor = decode(encoded, limits.decode);
    const decodeMs = performance.now() - decodeStartedAt;
    assertCurrent(dependencies.coordinator, attempt);

    stage = "recovery";
    const rendererWaitStartedAt = performance.now();
    const renderer = await dependencies.acquireRenderer(attempt.signal);
    const rendererWaitMs = performance.now() - rendererWaitStartedAt;
    assertCurrent(dependencies.coordinator, attempt);
    stage = "upload";
    const uploadStartedAt = performance.now();
    dependencies.coordinator.commitGeometryLoad(attempt, descriptor, renderer);
    const uploadMs = performance.now() - uploadStartedAt;
    dependencies.coordinator.recordGeometryLoadTimings({
      fetchReadMs,
      decodeMs,
      rendererWaitMs,
      uploadMs,
      totalMs: performance.now() - startedAt,
    });
    if (isDisposed()) return;
    dependencies.postMessage({
      type: "geometry-ready",
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      requestId: message.requestId,
      handle: message.handle,
    });
  } catch (error) {
    const aborted = attempt.signal.aborted || isAbortError(error);
    dependencies.coordinator.rollbackGeometryLoad(attempt, aborted);
    if (isDisposed()) return;
    dependencies.postMessage({
      type: "geometry-failed",
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      requestId: message.requestId,
      handle: message.handle,
      error: errorPayload(normalizeLoadError(error, stage, aborted)),
    });
  }
}

/** Reads a response body with deterministic size enforcement before decode. */
export async function readGeometryResponse(
  response: Response,
  maxEncodedBytes: number,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      await cancelResponseBody(response);
      throw new AssetError("LUME_ASSET_FORMAT", "fetch", "Invalid geometry Content-Length header.");
    }
    if (parsedLength > maxEncodedBytes) {
      await cancelResponseBody(response);
      encodedBudgetExceeded();
    }
  }

  if (response.body === null) {
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > maxEncodedBytes) encodedBudgetExceeded();
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBufferLike>[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      if (signal.aborted) throw abortedError();
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      if (chunk.byteLength > maxEncodedBytes - byteLength) encodedBudgetExceeded();
      byteLength += chunk.byteLength;
      chunks.push(chunk);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  }
  if (signal.aborted) throw abortedError();
  const joined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined.buffer;
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (response.body === null) return;
  await response.body.cancel().catch(() => undefined);
}

function assertCurrent(coordinator: ResourceCoordinator, attempt: GeometryLoadAttempt): void {
  if (!coordinator.isGeometryLoadCurrent(attempt)) throw abortedError();
}

function yieldColdPath(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortedError());
  return new Promise((resolve, reject) => {
    const handle = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, 0);
    const onAbort = (): void => {
      clearTimeout(handle);
      reject(abortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeLoadError(
  error: unknown,
  stage: "fetch" | "decode" | "upload" | "recovery",
  aborted: boolean,
): AssetError {
  if (aborted) return abortedError();
  if (isAssetError(error)) return error;
  if (stage === "fetch") {
    return new AssetError("LUME_ASSET_NETWORK", "fetch", "Geometry network request failed.");
  }
  if (stage === "upload" || stage === "recovery") {
    return new AssetError(
      "LUME_ASSET_GPU_UPLOAD",
      stage === "recovery" ? "recovery" : "upload",
      stage === "recovery"
        ? "Renderer recovery did not become available for geometry publication."
        : "Geometry GPU upload failed.",
    );
  }
  return new AssetError("LUME_ASSET_FORMAT", "geometry", "Geometry decode failed.");
}

function errorPayload(error: unknown): GeometryLoadErrorPayload {
  const normalized = isAssetError(error)
    ? error
    : new AssetError("LUME_ASSET_FORMAT", "request", "Geometry load request failed.");
  return {
    code: normalized.code,
    stage: normalized.stage,
    message: normalized.message,
  };
}

function encodedBudgetExceeded(): never {
  throw new AssetError(
    "LUME_ASSET_BUDGET_EXCEEDED",
    "budget",
    "Encoded geometry exceeds the configured request limit.",
  );
}

function abortedError(): AssetError {
  return new AssetError("LUME_ASSET_ABORTED", "lifecycle", "Geometry load was aborted.");
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { readonly name?: unknown }).name === "AbortError")
  );
}
