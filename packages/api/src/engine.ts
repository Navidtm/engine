import {
  createDefaultWorker,
  RUNTIME_PROTOCOL_VERSION,
  type MainToWorkerMessage,
  type EngineStats,
  type RuntimeCommand,
  type WorkerToMainMessage,
} from "@lume/runtime";
import type { Component, Entity } from "@lume/scene";

const MAX_ENTITY_INDEX = (1 << 20) - 1;

export type EngineStatus = "new" | "initializing" | "ready" | "running" | "stopped" | "disposed" | "failed";

export interface EngineConfig {
  readonly canvas: HTMLCanvasElement;
  readonly wasmUrl?: string | URL;
  readonly entityCapacity?: number;
  readonly powerPreference?: GPUPowerPreference;
  readonly alphaMode?: GPUCanvasAlphaMode;
  readonly clearColor?: GPUColor;
  readonly autoResize?: boolean;
  readonly workerFactory?: () => Worker;
  readonly onError?: (error: Error) => void;
}

export interface WorldApi {
  createEntity(): Entity;
  destroyEntity(entity: Entity): void;
  add(entity: Entity, component: Component): void;
}

export interface Engine {
  readonly world: WorldApi;
  readonly status: EngineStatus;
  init(): Promise<void>;
  start(): void;
  stop(): void;
  resize(): void;
  getStats(): Promise<EngineStats>;
  dispose(): void;
}

interface EngineState {
  readonly config: EngineConfig;
  readonly worker: Worker;
  readonly pendingCommands: RuntimeCommand[];
  status: EngineStatus;
  nextEntity: number;
  initPromise: Promise<void> | undefined;
  resolveInit: (() => void) | undefined;
  rejectInit: ((error: Error) => void) | undefined;
  resizeObserver: ResizeObserver | undefined;
  readonly statsRequests: Map<number, {
    readonly resolve: (stats: EngineStats) => void;
    readonly reject: (error: Error) => void;
  }>;
  nextStatsRequest: number;
}

export function createEngine(config: EngineConfig): Engine {
  const state: EngineState = {
    config,
    worker: (config.workerFactory ?? createDefaultWorker)(),
    pendingCommands: [],
    status: "new",
    nextEntity: 0,
    initPromise: undefined,
    resolveInit: undefined,
    rejectInit: undefined,
    resizeObserver: undefined,
    statsRequests: new Map(),
    nextStatsRequest: 1,
  };
  const world = createWorldApi(state);

  state.worker.addEventListener("message", (event: MessageEvent<WorkerToMainMessage>) => {
    handleWorkerMessage(state, event.data);
  });
  state.worker.addEventListener("error", (event) => {
    fail(state, new Error(event.message));
  });

  const engine: Engine = {
    world,
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
    dispose: () => dispose(state),
  };
  return Object.freeze(engine);
}

function createWorldApi(state: EngineState): WorldApi {
  const world: WorldApi = {
    createEntity() {
      if (state.status === "disposed") throw new Error("Cannot create an entity after disposal.");
      if (state.nextEntity > MAX_ENTITY_INDEX) throw new Error("Entity ID capacity exhausted.");
      const entity = state.nextEntity++ as Entity;
      dispatchCommand(state, { type: "spawn", entity });
      return entity;
    },
    destroyEntity(entity: Entity) {
      dispatchCommand(state, { type: "despawn", entity });
    },
    add(entity: Entity, component: Component) {
      dispatchCommand(state, componentCommand(entity, component));
    },
  };
  return Object.freeze(world);
}

function componentCommand(entity: Entity, component: Component): RuntimeCommand {
  switch (component.kind) {
    case "transform":
      return {
        type: "add-transform",
        entity,
        position: component.position,
        rotation: component.rotation,
        scale: component.scale,
      };
    case "material":
      return { type: "add-material", entity, color: component.color };
    case "camera":
      return {
        type: "add-camera",
        entity,
        verticalFov: component.verticalFov,
        near: component.near,
        far: component.far,
      };
    case "mesh":
      return {
        type: "add-mesh",
        entity,
        geometry: component.geometry.id,
        material: component.material,
      };
    case "bounds":
      return {
        type: "add-bounds",
        entity,
        center: component.center,
        radius: component.radius,
      };
  }
}

function initialize(state: EngineState): Promise<void> {
  if (state.initPromise !== undefined) return state.initPromise;
  if (state.status !== "new") return Promise.reject(new Error(`Cannot initialize from '${state.status}'.`));
  if (!("transferControlToOffscreen" in state.config.canvas)) {
    return Promise.reject(new Error("OffscreenCanvas transfer is unavailable in this browser."));
  }
  state.status = "initializing";
  state.initPromise = new Promise<void>((resolve, reject) => {
    state.resolveInit = resolve;
    state.rejectInit = reject;
  });

  const rect = state.config.canvas.getBoundingClientRect();
  const canvas = state.config.canvas.transferControlToOffscreen();
  const renderer = {
    ...(state.config.powerPreference === undefined ? {} : { powerPreference: state.config.powerPreference }),
    ...(state.config.alphaMode === undefined ? {} : { alphaMode: state.config.alphaMode }),
    ...(state.config.clearColor === undefined ? {} : { clearColor: state.config.clearColor }),
  };
  const message: MainToWorkerMessage = {
    type: "init",
    value: {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      canvas,
      wasmUrl: String(state.config.wasmUrl ?? new URL("/lume_core.wasm", document.baseURI)),
      entityCapacity: state.config.entityCapacity ?? 4_096,
      size: {
        width: rect.width,
        height: rect.height,
        devicePixelRatio: window.devicePixelRatio,
      },
      renderer,
    },
  };
  state.worker.postMessage(message, [canvas]);

  if (state.config.autoResize !== false && typeof ResizeObserver !== "undefined") {
    state.resizeObserver = new ResizeObserver(() => resize(state));
    state.resizeObserver.observe(state.config.canvas);
  }
  return state.initPromise;
}

function handleWorkerMessage(state: EngineState, message: WorkerToMainMessage): void {
  switch (message.type) {
    case "ready":
      state.status = "ready";
      if (state.pendingCommands.length > 0) {
        post(state, { type: "batch", value: state.pendingCommands.splice(0) });
      }
      state.resolveInit?.();
      state.resolveInit = undefined;
      state.rejectInit = undefined;
      break;
    case "stopped":
      if (state.status !== "disposed") state.status = "stopped";
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

function dispatchCommand(state: EngineState, command: RuntimeCommand): void {
  if (state.status === "disposed" || state.status === "failed") {
    throw new Error(`Cannot update a ${state.status} engine.`);
  }
  if (state.status === "new" || state.status === "initializing") {
    state.pendingCommands.push(command);
  } else {
    post(state, { type: "command", value: command });
  }
}

function resize(state: EngineState): void {
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

function dispose(state: EngineState): void {
  if (state.status === "disposed") return;
  state.resizeObserver?.disconnect();
  state.rejectInit?.(new Error("Engine disposed during initialization."));
  state.resolveInit = undefined;
  state.rejectInit = undefined;
  state.status = "disposed";
  rejectStatsRequests(state, new Error("Engine disposed before statistics were returned."));
  post(state, { type: "dispose" });
}

function getStats(state: EngineState): Promise<EngineStats> {
  requireInitialized(state, "read statistics");
  const requestId = state.nextStatsRequest++;
  return new Promise((resolve, reject) => {
    state.statsRequests.set(requestId, { resolve, reject });
    post(state, { type: "get-stats", requestId });
  });
}

function requireInitialized(state: EngineState, operation: string): void {
  if (state.status !== "ready" && state.status !== "running" && state.status !== "stopped") {
    throw new Error(`Cannot ${operation} while engine status is '${state.status}'.`);
  }
}

function post(state: EngineState, message: MainToWorkerMessage): void {
  state.worker.postMessage(message);
}

function fail(state: EngineState, error: Error): void {
  if (state.status === "failed" || state.status === "disposed") return;
  state.status = "failed";
  state.rejectInit?.(error);
  state.resolveInit = undefined;
  state.rejectInit = undefined;
  state.config.onError?.(error);
  rejectStatsRequests(state, error);
  post(state, { type: "dispose" });
}

function rejectStatsRequests(state: EngineState, error: Error): void {
  for (const request of state.statsRequests.values()) request.reject(error);
  state.statsRequests.clear();
}
