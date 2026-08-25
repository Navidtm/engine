import {
  allocateSharedRuntimeMemory,
  createDefaultWorker,
  defineRuntimeGeometryLimits,
  supportsSharedRuntimeMemory,
  type WorkerToMainMessage,
} from "@lume/runtime";

import { createEngineCamera } from "../camera-api.js";
import { createComponentCapacityState } from "../capacity.js";
import { createGeometryLoadApi, GeometryLoadError } from "../geometry-load-api.js";
import { createHighLevelApi } from "../resource-api.js";
import { createBuiltinGeometryApi, createResourceState } from "../resource-lifecycle.js";
import { createWorldApi } from "../world-api.js";
import {
  dispose,
  fail,
  getStats,
  handleWorkerMessage,
  initialize,
  resize,
  start,
  stop,
} from "./lifecycle.js";
import type { EngineState } from "./state.js";
import type { Engine, EngineConfig, EngineOptions } from "./types.js";
import { resolveEngineBudgets, validateEngineCameraOptions } from "./validation.js";

export type {
  BasicMaterialHandle,
  BasicMaterialOptions,
  BuiltinGeometryApi,
  CameraPerspectiveOptions,
  CanvasAlphaMode,
  ClearColor,
  CreateApi,
  Engine,
  EngineCamera,
  EngineCameraOptions,
  EngineComponentCapacityOptions,
  EngineConfig,
  EngineHandle,
  EngineOptions,
  EngineStatus,
  EngineTransportOptions,
  GeometryHandle,
  GeometryLoadLimits,
  GeometryLoadOptions,
  LoadApi,
  MeshHandle,
  MeshOptions,
  PowerPreference,
  QuaternionControl,
  SceneHandle,
  SetApi,
  Vector3Control,
  WorldApi,
} from "./types.js";

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
  const geometry = createBuiltinGeometryApi(state);
  const world = createWorldApi(state);
  const engineCamera = createEngineCamera(state, world, config.camera);
  const highLevel = createHighLevelApi(state, world, geometry);
  const load = createGeometryLoadApi(state, (error) => fail(state, error));

  state.worker.addEventListener("message", (event: MessageEvent<WorkerToMainMessage>) => {
    handleWorkerMessage(state, event.data);
  });
  state.worker.addEventListener("error", (event) => {
    fail(state, new Error(event.message));
  });

  return {
    create: highLevel.create,
    load,
    geometry,
    set: highLevel.set,
    world,
    camera: engineCamera,
    capacities: state.capacities,
    get status() {
      return state.status;
    },
    init: () => initialize(state),
    start: () => start(state),
    stop: () => stop(state),
    resize: () => resize(state),
    getStats: () => getStats(state),
    destroy: highLevel.destroy,
    dispose: () => dispose(state),
  };
}

function createEngineState(config: EngineConfig): EngineState {
  const budgets = resolveEngineBudgets(config);
  validateEngineCameraOptions(config.camera);
  const geometryLimits =
    config.geometryLimits === undefined
      ? undefined
      : defineRuntimeGeometryLimits(config.geometryLimits);
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
    meshRendererCapacity: budgets.meshRendererCapacity,
    cameraCapacity: budgets.cameraCapacity,
    boundsCapacity: budgets.boundsCapacity,
    entityGenerations: new Uint16Array(budgets.entityCapacity),
    entityAlive: new Uint8Array(budgets.entityCapacity),
    freeEntities: new Uint32Array(budgets.entityCapacity),
    resources: createResourceState(budgets.resourceCapacity, budgets.entityCapacity),
    components: createComponentCapacityState(
      budgets.entityCapacity,
      budgets.transformCapacity,
      budgets.cameraCapacity,
      budgets.meshRendererCapacity,
      budgets.boundsCapacity,
    ),
    capacities: budgets.capacities,
    geometryLimits,
    commandTransaction: undefined,
    nextEntityIndex: 0,
    freeEntityCount: 0,
    initPromise: undefined,
    resolveInit: undefined,
    rejectInit: undefined,
    resizeObserver: undefined,
    statsRequests: new Map(),
    nextStatsRequest: 1,
    geometryLoads: new Map(),
    nextGeometryRequest: 1,
    structuralFallback: false,
    lifecycleEpoch: 0,
    runningIntent: false,
  };
}

export { GeometryLoadError };
