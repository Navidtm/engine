import {
  type EngineStats,
  type MainToWorkerMessage,
  RUNTIME_PROTOCOL_VERSION,
  type WorkerToMainMessage,
} from "@lume/runtime";
import { getLumeWasmUrl } from "@lume/runtime/wasm-url";

import type { EngineState } from "./state.js";
import { post } from "./transport.js";
import type { PowerPreference } from "./types.js";

export function initialize(state: EngineState): Promise<void> {
  if (state.initPromise !== undefined) return state.initPromise;
  if (state.status !== "new") {
    return Promise.reject(new Error(`Cannot initialize from '${state.status}'.`));
  }
  if (!("transferControlToOffscreen" in state.config.canvas)) {
    return Promise.reject(new Error("OffscreenCanvas transfer is unavailable in this browser."));
  }
  let wasmUrl: string;
  try {
    wasmUrl = resolveWasmUrl(state.config.wasmUrl);
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  state.status = "initializing";
  state.initPromise = new Promise<void>((resolve, reject) => {
    state.resolveInit = resolve;
    state.rejectInit = reject;
  });

  const rect = state.config.canvas.getBoundingClientRect();
  const canvas = state.config.canvas.transferControlToOffscreen();
  const renderer = {
    ...(state.config.powerPreference === undefined
      ? {}
      : { powerPreference: webGpuPowerPreference(state.config.powerPreference) }),
    ...(state.config.alphaMode === undefined ? {} : { alphaMode: state.config.alphaMode }),
    ...(state.config.clearColor === undefined ? {} : { clearColor: state.config.clearColor }),
    ...(state.config.visibilityMode === undefined
      ? {}
      : { visibilityMode: state.config.visibilityMode }),
  };
  const message: MainToWorkerMessage = {
    type: "init",
    value: {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      canvas,
      wasmUrl,
      entityCapacity: state.entityCapacity,
      resourceCapacity: state.resources.capacity,
      transformCapacity: state.transformCapacity,
      meshRendererCapacity: state.meshRendererCapacity,
      cameraCapacity: state.cameraCapacity,
      boundsCapacity: state.boundsCapacity,
      size: {
        width: rect.width,
        height: rect.height,
        devicePixelRatio: window.devicePixelRatio,
      },
      renderer,
      ...(state.sharedMemory === undefined ? {} : { sharedMemory: state.sharedMemory.buffer }),
    },
  };
  state.worker.postMessage(message, [canvas]);

  if (state.config.autoResize !== false && typeof ResizeObserver !== "undefined") {
    state.resizeObserver = new ResizeObserver(() => resize(state));
    state.resizeObserver.observe(state.config.canvas);
  }
  return state.initPromise;
}

export function resolveWasmUrl(value: string | URL | undefined): string {
  if (value === undefined) return getLumeWasmUrl().href;
  if (value instanceof URL) return value.href;
  try {
    return new URL(value, document.baseURI).href;
  } catch (cause) {
    throw new TypeError(`wasmUrl must be a valid absolute or document-relative URL: ${value}`, {
      cause,
    });
  }
}

export function handleWorkerMessage(state: EngineState, message: WorkerToMainMessage): void {
  switch (message.type) {
    case "ready":
      if (state.status === "disposed" || state.status === "failed") break;
      state.status = "ready";
      if (state.pendingCommands.length > 0) {
        post(state, { type: "batch", value: state.pendingCommands.splice(0) });
      }
      state.resolveInit?.();
      state.resolveInit = undefined;
      state.rejectInit = undefined;
      break;
    case "stopped":
      if (
        message.lifecycleEpoch === state.lifecycleEpoch &&
        !state.runningIntent &&
        state.status !== "disposed" &&
        state.status !== "failed"
      ) {
        state.status = "stopped";
      }
      break;
    case "disposed":
      state.worker.terminate();
      break;
    case "stats": {
      const request = state.statsRequests.get(message.requestId);
      if (request !== undefined) {
        state.statsRequests.delete(message.requestId);
        request.resolve(message.value);
      }
      break;
    }
    case "error":
      fail(state, Object.assign(new Error(message.message), { stack: message.stack }));
      break;
    case "device-lost":
      fail(state, new Error(`WebGPU device lost (${message.reason}): ${message.message}`));
      break;
  }
}

export function resize(state: EngineState): void {
  if (state.status === "new" || state.status === "disposed" || state.status === "failed") return;
  const rect = state.config.canvas.getBoundingClientRect();
  post(state, {
    type: "resize",
    value: {
      width: rect.width,
      height: rect.height,
      devicePixelRatio: window.devicePixelRatio,
    },
  });
}

export function start(state: EngineState): void {
  requireInitialized(state, "start");
  if (state.runningIntent) return;
  state.runningIntent = true;
  state.status = "running";
  post(state, { type: "start", lifecycleEpoch: advanceLifecycleEpoch(state) });
}

export function stop(state: EngineState): void {
  if (!state.runningIntent) return;
  state.runningIntent = false;
  post(state, { type: "stop", lifecycleEpoch: advanceLifecycleEpoch(state) });
}

export function dispose(state: EngineState): void {
  if (state.status === "disposed") return;
  state.resizeObserver?.disconnect();
  state.rejectInit?.(new Error("Engine disposed during initialization."));
  state.resolveInit = undefined;
  state.rejectInit = undefined;
  state.runningIntent = false;
  advanceLifecycleEpoch(state);
  state.status = "disposed";
  rejectStatsRequests(state, new Error("Engine disposed before statistics were returned."));
  post(state, { type: "dispose" });
}

export function getStats(state: EngineState): Promise<EngineStats> {
  requireInitialized(state, "read statistics");
  const requestId = state.nextStatsRequest++;
  return new Promise((resolve, reject) => {
    state.statsRequests.set(requestId, { resolve, reject });
    post(state, { type: "get-stats", requestId });
  });
}

export function requireInitialized(state: EngineState, operation: string): void {
  if (state.status !== "ready" && state.status !== "running" && state.status !== "stopped") {
    throw new Error(`Cannot ${operation} while engine status is '${state.status}'.`);
  }
}

export function fail(state: EngineState, error: Error): void {
  if (state.status === "failed" || state.status === "disposed") return;
  state.runningIntent = false;
  advanceLifecycleEpoch(state);
  state.status = "failed";
  state.rejectInit?.(error);
  state.resolveInit = undefined;
  state.rejectInit = undefined;
  state.config.onError?.(error);
  rejectStatsRequests(state, error);
  post(state, { type: "dispose" });
}

function webGpuPowerPreference(preference: PowerPreference): GPUPowerPreference {
  return preference === "high" ? "high-performance" : "low-power";
}

function rejectStatsRequests(state: EngineState, error: Error): void {
  for (const request of state.statsRequests.values()) request.reject(error);
  state.statsRequests.clear();
}

function advanceLifecycleEpoch(state: EngineState): number {
  state.lifecycleEpoch += 1;
  return state.lifecycleEpoch;
}
