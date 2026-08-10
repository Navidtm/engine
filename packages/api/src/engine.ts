import {
  allocateSharedRuntimeMemory,
  createDefaultWorker,
  supportsSharedRuntimeMemory,
  type WorkerToMainMessage,
} from "@lume/runtime";

import { createEngineCamera } from "./camera-api.js";
import {
  dispose,
  fail,
  getStats,
  handleWorkerMessage,
  initialize,
  requireInitialized,
  resize,
} from "./engine/engine-lifecycle.js";
import type { EngineState } from "./engine/engine-state.js";
import { post } from "./engine/engine-transport.js";
import type { Engine, EngineConfig, EngineOptions } from "./engine/engine-types.js";
import { resolveEngineBudgets, validateEngineCameraOptions } from "./engine/engine-validation.js";
import { createHighLevelApi } from "./resource-api.js";
import { createWorldApi } from "./world-api.js";

export type {
  BasicMaterialHandle,
  BasicMaterialOptions,
  CameraPerspectiveOptions,
  CreateApi,
  Engine,
  EngineCamera,
  EngineCameraOptions,
  EngineConfig,
  EngineHandle,
  EngineOptions,
  EngineStatus,
  EngineTransportOptions,
  MeshHandle,
  MeshOptions,
  PowerPreference,
  QuaternionControl,
  SceneHandle,
  SetApi,
  Vector3Control,
  WorldApi,
} from "./engine/engine-types.js";

/**
 * Creates a worker-owned WebGPU engine. It does not allocate GPU resources until `init()`.
 *
 * @throws {RangeError} When capacity budgets are invalid.
 */
export function createEngine(canvas: HTMLCanvasElement, options?: EngineOptions): Engine;
export function createEngine(config: EngineConfig): Engine;
export function createEngine(
  canvasOrConfig: HTMLCanvasElement | EngineConfig,
  options: EngineOptions = {},
): Engine {
  const config: EngineConfig =
    "canvas" in canvasOrConfig ? canvasOrConfig : { ...options, canvas: canvasOrConfig };
  const state = createEngineState(config);
  const world = createWorldApi(state);
  const engineCamera = createEngineCamera(state, world, config.camera);
  const highLevel = createHighLevelApi(state, world);

  state.worker.addEventListener("message", (event: MessageEvent<WorkerToMainMessage>) => {
    handleWorkerMessage(state, event.data);
  });
  state.worker.addEventListener("error", (event) => {
    fail(state, new Error(event.message));
  });

  return {
    create: highLevel.create,
    set: highLevel.set,
    world,
    camera: engineCamera,
    get status() {
      return state.status;
    },
    init: () => initialize(state),
    start() {
      requireInitialized(state, "start");
      state.status = "running";
      post(state, { type: "start" });
    },
    stop() {
      if (state.status !== "running") return;
      state.status = "stopped";
      post(state, { type: "stop" });
    },
    resize: () => resize(state),
    getStats: () => getStats(state),
    destroy: highLevel.destroy,
    dispose: () => dispose(state),
  };
}

function createEngineState(config: EngineConfig): EngineState {
  const budgets = resolveEngineBudgets(config);
  validateEngineCameraOptions(config.camera);
  return {
    config,
    worker: (config.workerFactory ?? createDefaultWorker)(),
    pendingCommands: [],
    sharedMemory: supportsSharedRuntimeMemory()
      ? allocateSharedRuntimeMemory(budgets.transformCapacity, budgets.structuralCommandCapacity)
      : undefined,
    status: "new",
    entityCapacity: budgets.entityCapacity,
    transformCapacity: budgets.transformCapacity,
    entityGenerations: new Uint16Array(budgets.entityCapacity),
    entityAlive: new Uint8Array(budgets.entityCapacity),
    freeEntities: new Uint32Array(budgets.entityCapacity),
    nextEntityIndex: 0,
    freeEntityCount: 0,
    initPromise: undefined,
    resolveInit: undefined,
    rejectInit: undefined,
    resizeObserver: undefined,
    statsRequests: new Map(),
    nextStatsRequest: 1,
    structuralFallback: false,
  };
}
