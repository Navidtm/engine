import {
  allocateSharedRuntimeMemory,
  createDefaultWorker,
  type EngineStats,
  type MainToWorkerMessage,
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeCommand,
  type SharedRuntimeViews,
  supportsSharedRuntimeMemory,
  TransformField,
  type WorkerToMainMessage,
  writeSharedCommand,
  writeSharedTransform,
} from "@lume/runtime";
import {
  bounds,
  boxGeometry,
  camera,
  type Color,
  type Component,
  type Entity,
  material,
  mesh,
  type Quat,
  transform,
  triangleGeometry,
  type Vec3,
} from "@lume/scene";

const MAX_ENTITY_INDEX = (1 << 20) - 1;
const MAX_ENTITY_GENERATION = (1 << 12) - 1;
const ENTITY_OWNER = Symbol("lume-entity-owner");

export type EngineStatus =
  "new" | "initializing" | "ready" | "running" | "stopped" | "disposed" | "failed";

export interface EngineConfig {
  readonly canvas: HTMLCanvasElement;
  readonly wasmUrl?: string | URL;
  readonly entityCapacity?: number;
  /** Maximum structural commands held in the shared ring before ordered fallback. */
  readonly structuralCommandCapacity?: number;
  readonly powerPreference?: GPUPowerPreference;
  readonly alphaMode?: GPUCanvasAlphaMode;
  readonly clearColor?: GPUColor;
  readonly autoResize?: boolean;
  readonly workerFactory?: () => Worker;
  readonly onError?: (error: Error) => void;
}

export type EngineOptions = Omit<EngineConfig, "canvas">;

export interface BasicMaterialHandle {
  readonly kind: "basic-material";
  readonly id: Entity;
}

export interface MeshHandle {
  readonly kind: "mesh";
  readonly id: Entity;
  readonly position: Vector3Control;
  readonly rotation: QuaternionControl;
  readonly scale: Vector3Control;
}

export interface CameraHandle {
  readonly kind: "camera";
  readonly id: Entity;
  readonly position: Vector3Control;
  readonly rotation: QuaternionControl;
  readonly scale: Vector3Control;
}

export interface Vector3Control {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  set(x: number, y: number, z: number): void;
}

export interface QuaternionControl {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
  set(x: number, y: number, z: number, w: number): void;
}

export type EngineHandle = BasicMaterialHandle | MeshHandle | CameraHandle;
export type SceneHandle = MeshHandle | CameraHandle;

export interface BasicMaterialOptions {
  readonly color?: Color;
}

export interface MeshOptions {
  readonly geometry: "cube" | "triangle";
  readonly material?: BasicMaterialHandle | "basic";
  readonly position?: Vec3;
  readonly rotation?: Quat;
  readonly scale?: Vec3;
  readonly bounds?: { readonly center?: Vec3; readonly radius: number };
}

export interface PerspectiveCameraOptions {
  readonly position?: Vec3;
  readonly rotation?: Quat;
  readonly verticalFov?: number;
  readonly near?: number;
  readonly far?: number;
}

export interface CreateApi {
  basicMaterial(options?: BasicMaterialOptions): BasicMaterialHandle;
  mesh(options: MeshOptions): MeshHandle;
  perspectiveCamera(options?: PerspectiveCameraOptions): CameraHandle;
}

export interface SetApi {
  transform(
    handle: SceneHandle,
    options: {
      readonly position?: Vec3;
      readonly rotation?: Quat;
      readonly scale?: Vec3;
    },
  ): void;
}

export interface WorldApi {
  createEntity(): Entity;
  destroyEntity(entity: Entity): void;
  add(entity: Entity, component: Component): void;
  remove(entity: Entity, component: Component["kind"]): void;
}

export interface Engine {
  readonly create: CreateApi;
  readonly set: SetApi;
  readonly world: WorldApi;
  readonly status: EngineStatus;
  init(): Promise<void>;
  start(): void;
  stop(): void;
  resize(): void;
  getStats(): Promise<EngineStats>;
  destroy(handle: EngineHandle): void;
  dispose(): void;
}

interface EngineState {
  readonly config: EngineConfig;
  readonly worker: Worker;
  readonly pendingCommands: RuntimeCommand[];
  readonly sharedMemory: SharedRuntimeViews | undefined;
  status: EngineStatus;
  readonly entityCapacity: number;
  readonly entityGenerations: Uint16Array;
  readonly entityAlive: Uint8Array;
  readonly freeEntities: Uint32Array;
  nextEntityIndex: number;
  freeEntityCount: number;
  initPromise: Promise<void> | undefined;
  resolveInit: (() => void) | undefined;
  rejectInit: ((error: Error) => void) | undefined;
  resizeObserver: ResizeObserver | undefined;
  readonly statsRequests: Map<
    number,
    {
      readonly resolve: (stats: EngineStats) => void;
      readonly reject: (error: Error) => void;
    }
  >;
  nextStatsRequest: number;
  structuralFallback: boolean;
}

type OwnedEntity = Entity & { readonly [ENTITY_OWNER]: EngineState };

export function createEngine(canvas: HTMLCanvasElement, options?: EngineOptions): Engine;
export function createEngine(config: EngineConfig): Engine;
export function createEngine(
  canvasOrConfig: HTMLCanvasElement | EngineConfig,
  options: EngineOptions = {},
): Engine {
  const config: EngineConfig =
    "canvas" in canvasOrConfig ? canvasOrConfig : { ...options, canvas: canvasOrConfig };
  const entityCapacity = config.entityCapacity ?? 4_096;
  if (!Number.isSafeInteger(entityCapacity) || entityCapacity <= 0 || entityCapacity > 1 << 20) {
    throw new RangeError("entityCapacity must be an integer between 1 and 1,048,576.");
  }
  const structuralCommandCapacity =
    config.structuralCommandCapacity ?? Math.min(entityCapacity, 1_024);
  if (
    !Number.isSafeInteger(structuralCommandCapacity) ||
    structuralCommandCapacity <= 0 ||
    structuralCommandCapacity > entityCapacity
  ) {
    throw new RangeError(
      "structuralCommandCapacity must be an integer between 1 and entityCapacity.",
    );
  }
  const state: EngineState = {
    config,
    worker: (config.workerFactory ?? createDefaultWorker)(),
    pendingCommands: [],
    sharedMemory: supportsSharedRuntimeMemory()
      ? allocateSharedRuntimeMemory(entityCapacity, structuralCommandCapacity)
      : undefined,
    status: "new",
    entityCapacity,
    entityGenerations: new Uint16Array(entityCapacity),
    entityAlive: new Uint8Array(entityCapacity),
    freeEntities: new Uint32Array(entityCapacity),
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
  const world = createWorldApi(state);
  const highLevel = createHighLevelApi(state, world);

  state.worker.addEventListener("message", (event: MessageEvent<WorkerToMainMessage>) => {
    handleWorkerMessage(state, event.data);
  });
  state.worker.addEventListener("error", (event) => {
    fail(state, new Error(event.message));
  });

  const engine: Engine = {
    create: highLevel.create,
    set: highLevel.set,
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
    destroy: highLevel.destroy,
    dispose: () => dispose(state),
  };
  return Object.freeze(engine);
}

interface MutableTransformValue {
  readonly position: [number, number, number];
  readonly rotation: [number, number, number, number];
  readonly scale: [number, number, number];
}

function createHighLevelApi(
  state: EngineState,
  world: WorldApi,
): {
  readonly create: CreateApi;
  readonly set: SetApi;
  readonly destroy: (handle: EngineHandle) => void;
} {
  let defaultMaterial: BasicMaterialHandle | undefined;
  const transforms = new WeakMap<SceneHandle, MutableTransformValue>();
  const createBasicMaterial = (options: BasicMaterialOptions = {}): BasicMaterialHandle => {
    const entity = world.createEntity();
    world.add(entity, material(options));
    return Object.freeze({ kind: "basic-material", id: entity });
  };
  const defaultBasicMaterial = (): BasicMaterialHandle => {
    defaultMaterial ??= createBasicMaterial();
    return defaultMaterial;
  };
  const create: CreateApi = Object.freeze({
    basicMaterial: createBasicMaterial,
    mesh(options: MeshOptions) {
      const materialHandle =
        options.material === undefined || options.material === "basic"
          ? defaultBasicMaterial()
          : options.material;
      const entity = world.createEntity();
      const initialTransform = mutableTransform(options);
      world.add(
        entity,
        transform({
          ...(options.position === undefined ? {} : { position: options.position }),
          ...(options.rotation === undefined ? {} : { rotation: options.rotation }),
          ...(options.scale === undefined ? {} : { scale: options.scale }),
        }),
      );
      const geometry = options.geometry === "cube" ? boxGeometry() : triangleGeometry();
      world.add(entity, mesh(geometry, materialHandle.id));
      if (options.bounds !== undefined) world.add(entity, bounds(options.bounds));
      const handle = createSceneHandle(state, "mesh", entity, initialTransform);
      transforms.set(handle, initialTransform);
      return handle;
    },
    perspectiveCamera(options: PerspectiveCameraOptions = {}) {
      const entity = world.createEntity();
      const initialTransform = mutableTransform(options);
      world.add(
        entity,
        transform({
          ...(options.position === undefined ? {} : { position: options.position }),
          ...(options.rotation === undefined ? {} : { rotation: options.rotation }),
        }),
      );
      world.add(
        entity,
        camera({
          ...(options.verticalFov === undefined ? {} : { verticalFov: options.verticalFov }),
          ...(options.near === undefined ? {} : { near: options.near }),
          ...(options.far === undefined ? {} : { far: options.far }),
        }),
      );
      const handle = createSceneHandle(state, "camera", entity, initialTransform);
      transforms.set(handle, initialTransform);
      return handle;
    },
  });
  const set: SetApi = Object.freeze({
    transform(
      handle: SceneHandle,
      options: {
        readonly position?: Vec3;
        readonly rotation?: Quat;
        readonly scale?: Vec3;
      },
    ) {
      const value = transforms.get(handle);
      if (value === undefined) throw new Error("Scene handle does not belong to this engine.");
      if (options.position !== undefined) copyVec3(value.position, options.position);
      if (options.rotation !== undefined) copyQuat(value.rotation, options.rotation);
      if (options.scale !== undefined) copyVec3(value.scale, options.scale);
      let fieldMask = 0;
      if (options.position !== undefined) fieldMask |= TransformField.Position;
      if (options.rotation !== undefined) fieldMask |= TransformField.Rotation;
      if (options.scale !== undefined) fieldMask |= TransformField.Scale;
      if (fieldMask !== 0) publishTransform(state, handle.id, value, fieldMask);
    },
  });
  return Object.freeze({
    create,
    set,
    destroy(handle: EngineHandle) {
      world.destroyEntity(handle.id);
      if (handle === defaultMaterial) defaultMaterial = undefined;
    },
  });
}

function mutableTransform(options: {
  readonly position?: Vec3;
  readonly rotation?: Quat;
  readonly scale?: Vec3;
}): MutableTransformValue {
  const position = options.position ?? [0, 0, 0];
  const rotation = options.rotation ?? [0, 0, 0, 1];
  const scale = options.scale ?? [1, 1, 1];
  return {
    position: [position[0], position[1], position[2]],
    rotation: [rotation[0], rotation[1], rotation[2], rotation[3]],
    scale: [scale[0], scale[1], scale[2]],
  };
}

function createSceneHandle<Kind extends "mesh" | "camera">(
  state: EngineState,
  kind: Kind,
  entity: Entity,
  value: MutableTransformValue,
): Kind extends "mesh" ? MeshHandle : CameraHandle {
  const position = createVector3Control(value.position, () =>
    publishTransform(state, entity, value, TransformField.Position),
  );
  const rotation = createQuaternionControl(value.rotation, () =>
    publishTransform(state, entity, value, TransformField.Rotation),
  );
  const scale = createVector3Control(value.scale, () =>
    publishTransform(state, entity, value, TransformField.Scale),
  );
  return Object.freeze({
    kind,
    id: entity,
    position,
    rotation,
    scale,
  }) as unknown as Kind extends "mesh" ? MeshHandle : CameraHandle;
}

function createVector3Control(
  value: [number, number, number],
  publish: () => void,
): Vector3Control {
  return Object.freeze({
    get x() {
      return value[0];
    },
    get y() {
      return value[1];
    },
    get z() {
      return value[2];
    },
    set(x: number, y: number, z: number) {
      value[0] = x;
      value[1] = y;
      value[2] = z;
      publish();
    },
  });
}

function createQuaternionControl(
  value: [number, number, number, number],
  publish: () => void,
): QuaternionControl {
  return Object.freeze({
    get x() {
      return value[0];
    },
    get y() {
      return value[1];
    },
    get z() {
      return value[2];
    },
    get w() {
      return value[3];
    },
    set(x: number, y: number, z: number, w: number) {
      value[0] = x;
      value[1] = y;
      value[2] = z;
      value[3] = w;
      publish();
    },
  });
}

function publishTransform(
  state: EngineState,
  entity: Entity,
  value: MutableTransformValue,
  fieldMask: number,
): void {
  if (state.status === "disposed" || state.status === "failed") {
    throw new Error(`Cannot update a ${state.status} engine.`);
  }
  validateLiveEntity(state, entity);
  const packedEntity = packEntity(entity);
  if (state.sharedMemory !== undefined) {
    writeSharedTransform(state.sharedMemory, packedEntity, value, fieldMask);
    return;
  }
  dispatchCommand(state, {
    type: "add-transform",
    entity: packedEntity,
    position: value.position,
    rotation: value.rotation,
    scale: value.scale,
  });
}

function copyVec3(target: [number, number, number], source: Vec3): void {
  target[0] = source[0];
  target[1] = source[1];
  target[2] = source[2];
}

function copyQuat(target: [number, number, number, number], source: Quat): void {
  target[0] = source[0];
  target[1] = source[1];
  target[2] = source[2];
  target[3] = source[3];
}

function createWorldApi(state: EngineState): WorldApi {
  const world: WorldApi = {
    createEntity() {
      if (state.status === "disposed") throw new Error("Cannot create an entity after disposal.");
      const index = allocateEntityIndex(state);
      const entity = createEntityHandle(state, index, state.entityGenerations[index] ?? 0);
      state.entityAlive[index] = 1;
      dispatchCommand(state, { type: "spawn", entity: packEntity(entity) });
      return entity;
    },
    destroyEntity(entity: Entity) {
      validateLiveEntity(state, entity);
      dispatchCommand(state, { type: "despawn", entity: packEntity(entity) });
      state.entityAlive[entity.index] = 0;
      state.entityGenerations[entity.index] = (entity.generation + 1) & MAX_ENTITY_GENERATION;
      state.freeEntities[state.freeEntityCount] = entity.index;
      state.freeEntityCount += 1;
    },
    add(entity: Entity, component: Component) {
      validateLiveEntity(state, entity);
      dispatchCommand(state, componentCommand(entity, component));
    },
    remove(entity: Entity, component: Component["kind"]) {
      validateLiveEntity(state, entity);
      dispatchCommand(state, { type: "remove-component", entity: packEntity(entity), component });
    },
  };
  return Object.freeze(world);
}

function componentCommand(entity: Entity, component: Component): RuntimeCommand {
  const packedEntity = packEntity(entity);
  switch (component.kind) {
    case "transform":
      return {
        type: "add-transform",
        entity: packedEntity,
        position: component.position,
        rotation: component.rotation,
        scale: component.scale,
      };
    case "material":
      return { type: "add-material", entity: packedEntity, color: component.color };
    case "camera":
      return {
        type: "add-camera",
        entity: packedEntity,
        verticalFov: component.verticalFov,
        near: component.near,
        far: component.far,
      };
    case "mesh":
      return {
        type: "add-mesh",
        entity: packedEntity,
        geometry: component.geometry.id,
        material: packEntity(component.material),
      };
    case "bounds":
      return {
        type: "add-bounds",
        entity: packedEntity,
        center: component.center,
        radius: component.radius,
      };
  }
}

function allocateEntityIndex(state: EngineState): number {
  if (state.freeEntityCount > 0) {
    state.freeEntityCount -= 1;
    return state.freeEntities[state.freeEntityCount] ?? 0;
  }
  if (state.nextEntityIndex >= state.entityCapacity || state.nextEntityIndex > MAX_ENTITY_INDEX) {
    throw new Error("Entity capacity exhausted.");
  }
  const index = state.nextEntityIndex;
  state.nextEntityIndex += 1;
  return index;
}

function createEntityHandle(state: EngineState, index: number, generation: number): OwnedEntity {
  const entity = { index, generation } as OwnedEntity;
  Object.defineProperty(entity, ENTITY_OWNER, { value: state });
  return Object.freeze(entity);
}

function validateLiveEntity(state: EngineState, entity: Entity): void {
  if (
    !Number.isInteger(entity.index) ||
    !Number.isInteger(entity.generation) ||
    entity.index < 0 ||
    entity.index >= state.entityCapacity ||
    entity.generation < 0 ||
    entity.generation > MAX_ENTITY_GENERATION ||
    state.entityAlive[entity.index] !== 1 ||
    state.entityGenerations[entity.index] !== entity.generation ||
    (entity as Partial<OwnedEntity>)[ENTITY_OWNER] !== state
  ) {
    throw new Error("Entity handle is stale or does not belong to this engine.");
  }
}

function packEntity(entity: Entity): number {
  return ((entity.generation << 20) | entity.index) >>> 0;
}

function initialize(state: EngineState): Promise<void> {
  if (state.initPromise !== undefined) return state.initPromise;
  if (state.status !== "new")
    return Promise.reject(new Error(`Cannot initialize from '${state.status}'.`));
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
    ...(state.config.powerPreference === undefined
      ? {}
      : { powerPreference: state.config.powerPreference }),
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
  } else if (
    !state.structuralFallback &&
    state.sharedMemory !== undefined &&
    writeSharedCommand(state.sharedMemory, command)
  ) {
    return;
  } else {
    state.structuralFallback = true;
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
