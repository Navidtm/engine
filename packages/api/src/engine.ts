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

import {
  allocateEntity,
  packEntity,
  peekEntityIndex,
  releaseEntity,
  validateLiveEntity,
} from "./entity-lifecycle.js";

/** Lifecycle state exposed by an engine instance. */
export type EngineStatus =
  "new" | "initializing" | "ready" | "running" | "stopped" | "disposed" | "failed";

/** Simple application-level preference mapped to the WebGPU adapter preference. */
export type PowerPreference = "high" | "low";

/** Advanced fixed budgets for the worker transport. */
export interface EngineTransportOptions {
  /**
   * Upper exclusive entity index that may publish shared transform updates.
   * Defaults to `entityCapacity`; lower it only when transform-bearing entities
   * are allocated before non-transform entities.
   */
  readonly transformCapacity?: number;
  /**
   * Maximum structural commands held in the shared SPSC ring before fallback.
   * Defaults to `min(entityCapacity, 1,024)`.
   */
  readonly structuralCommandCapacity?: number;
}

/** Full configuration accepted by {@link createEngine}. */
export interface EngineConfig {
  /** Canvas transferred to the worker as an OffscreenCanvas during `init()`. */
  readonly canvas: HTMLCanvasElement;
  /** Raw Lume WASM URL; defaults to `/lume_core.wasm`. */
  readonly wasmUrl?: string | URL;
  /** Maximum live entity slots, from 1 through 1,048,576. */
  readonly entityCapacity?: number;
  /** Advanced SharedArrayBuffer and worker transport budgets. */
  readonly transport?: EngineTransportOptions;
  /** Prefers a high-performance (`"high"`) or power-efficient (`"low"`) adapter. */
  readonly powerPreference?: PowerPreference;
  /** Canvas compositing mode; opaque by default. */
  readonly alphaMode?: GPUCanvasAlphaMode;
  /** Main render-pass clear color. */
  readonly clearColor?: GPUColor;
  /** Set false when the application controls resize timing. */
  readonly autoResize?: boolean;
  /** Worker factory hook for tests or custom embedding. */
  readonly workerFactory?: () => Worker;
  /** Receives asynchronous worker, initialization, and device-loss errors. */
  readonly onError?: (error: Error) => void;
}

/** Configuration for the overload of {@link createEngine} that receives a canvas first. */
export type EngineOptions = Omit<EngineConfig, "canvas">;

/** Opaque handle for a color-only material owned by one engine. */
export interface BasicMaterialHandle {
  /** Type discriminant for narrowing engine handles. */
  readonly kind: "basic-material";
  /** Stable material entity owned by this engine. */
  readonly id: Entity;
}

/** Mesh handle plus live transform controls. Do not construct this object manually. */
export interface MeshHandle {
  /** Type discriminant for narrowing engine handles. */
  readonly kind: "mesh";
  /** Stable mesh entity owned by this engine. */
  readonly id: Entity;
  /** Position control; publishes a position-only update. */
  readonly position: Vector3Control;
  /** Rotation control; publishes a rotation-only update. */
  readonly rotation: QuaternionControl;
  /** Scale control; publishes a scale-only update. */
  readonly scale: Vector3Control;
}

/** Perspective-camera handle plus live transform controls. */
export interface CameraHandle {
  /** Type discriminant for narrowing engine handles. */
  readonly kind: "camera";
  /** Stable camera entity owned by this engine. */
  readonly id: Entity;
  /** Camera position control. */
  readonly position: Vector3Control;
  /** Camera rotation control. */
  readonly rotation: QuaternionControl;
  /** Camera scale control. */
  readonly scale: Vector3Control;
}

/** Mutable position or scale control that publishes only the changed transform field. */
export interface Vector3Control {
  /** Current X component. */
  readonly x: number;
  /** Current Y component. */
  readonly y: number;
  /** Current Z component. */
  readonly z: number;
  /** Sets finite XYZ components and publishes this field. */
  set(x: number, y: number, z: number): void;
}

/** Mutable rotation control using XYZW quaternion components. */
export interface QuaternionControl {
  /** Current X component. */
  readonly x: number;
  /** Current Y component. */
  readonly y: number;
  /** Current Z component. */
  readonly z: number;
  /** Current W component. */
  readonly w: number;
  /** Sets finite, non-zero XYZW components and publishes this field. */
  set(x: number, y: number, z: number, w: number): void;
}

/** Any high-level resource handle that can be passed to {@link Engine.destroy}. */
export type EngineHandle = BasicMaterialHandle | MeshHandle | CameraHandle;
/** A high-level handle that has a transform. */
export type SceneHandle = MeshHandle | CameraHandle;

/** Creation options for a basic linear-RGBA material. */
export interface BasicMaterialOptions {
  /** Linear RGBA color; every channel must be finite and within `[0, 1]`. */
  readonly color?: Color;
}

/** Creation options for a built-in triangle or cube mesh. */
export interface MeshOptions {
  /** Built-in mesh geometry. */
  readonly geometry: "cube" | "triangle";
  /** Material handle, or `"basic"`/omitted for the engine shared default. */
  readonly material?: BasicMaterialHandle | "basic";
  /** Initial local XYZ position. */
  readonly position?: Vec3;
  /** Initial local XYZW quaternion. */
  readonly rotation?: Quat;
  /** Initial local XYZ scale. */
  readonly scale?: Vec3;
  /** Local bounding sphere for CPU culling. */
  readonly bounds?: { readonly center?: Vec3; readonly radius: number };
}

/** Creation options for a perspective camera. Angles are in radians. */
export interface PerspectiveCameraOptions {
  /** Initial camera XYZ position. */
  readonly position?: Vec3;
  /** Initial camera XYZW orientation. */
  readonly rotation?: Quat;
  /** Vertical field of view in radians. */
  readonly verticalFov?: number;
  /** Positive near clipping plane. */
  readonly near?: number;
  /** Far clipping plane; must be greater than `near`. */
  readonly far?: number;
}

/** Convenience authoring functions available as `engine.create`. */
export interface CreateApi {
  /** Creates a color-only material handle. */
  basicMaterial(options?: BasicMaterialOptions): BasicMaterialHandle;
  /** Creates a triangle or cube mesh with transform and mesh components. */
  mesh(options: MeshOptions): MeshHandle;
  /** Creates a perspective camera with an initial transform. */
  perspectiveCamera(options?: PerspectiveCameraOptions): CameraHandle;
}

/** Batched transform setter available as `engine.set`. */
export interface SetApi {
  transform(
    handle: SceneHandle,
    options: {
      /** Optional replacement local position. */
      readonly position?: Vec3;
      /** Optional replacement local rotation. */
      readonly rotation?: Quat;
      /** Optional replacement local scale. */
      readonly scale?: Vec3;
    },
  ): void;
}

/** Advanced ECS-style authoring API. Prefer `engine.create` for normal use. */
export interface WorldApi {
  /** Allocates a bare entity for advanced component authoring. */
  createEntity(): Entity;
  /** Despawns an entity and invalidates every handle for its old generation. */
  destroyEntity(entity: Entity): void;
  /** Adds or replaces one serializable component. */
  add(entity: Entity, component: Component): void;
  /** Removes one component kind from a live entity. */
  remove(entity: Entity, component: Component["kind"]): void;
}

/**
 * Public engine facade. Create resources before `init`; call `start` after it resolves.
 *
 * @example
 * const engine = createEngine(canvas);
 * engine.create.mesh({ geometry: "cube" });
 * engine.create.perspectiveCamera({ position: [0, 0, 3] });
 * await engine.init();
 * engine.start();
 */
export interface Engine {
  /** High-level creation API. */
  readonly create: CreateApi;
  /** Partial transform updates. */
  readonly set: SetApi;
  /** Advanced component API. */
  readonly world: WorldApi;
  /** Current lifecycle state. */
  readonly status: EngineStatus;
  /** Initializes the worker, WASM core, and WebGPU renderer. */
  init(): Promise<void>;
  /** Starts the worker frame loop after initialization. */
  start(): void;
  /** Stops the frame loop without destroying resources. */
  stop(): void;
  /** Publishes the canvas size; normally invoked by the resize observer. */
  resize(): void;
  /** Requests a worker statistics snapshot. */
  getStats(): Promise<EngineStats>;
  /** Destroys a high-level handle and recycles its entity slot. */
  destroy(handle: EngineHandle): void;
  /** Stops the engine and releases worker, WASM, and GPU resources. */
  dispose(): void;
}

interface EngineState {
  readonly config: EngineConfig;
  readonly worker: Worker;
  readonly pendingCommands: RuntimeCommand[];
  readonly sharedMemory: SharedRuntimeViews | undefined;
  status: EngineStatus;
  readonly entityCapacity: number;
  readonly transformCapacity: number;
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
  const entityCapacity = config.entityCapacity ?? 4_096;
  if (!Number.isSafeInteger(entityCapacity) || entityCapacity <= 0 || entityCapacity > 1 << 20) {
    throw new RangeError("entityCapacity must be an integer between 1 and 1,048,576.");
  }
  const transformCapacity = config.transport?.transformCapacity ?? entityCapacity;
  if (
    !Number.isSafeInteger(transformCapacity) ||
    transformCapacity <= 0 ||
    transformCapacity > entityCapacity
  ) {
    throw new RangeError(
      "transport.transformCapacity must be an integer between 1 and entityCapacity.",
    );
  }
  const structuralCommandCapacity =
    config.transport?.structuralCommandCapacity ?? Math.min(entityCapacity, 1_024);
  if (
    !Number.isSafeInteger(structuralCommandCapacity) ||
    structuralCommandCapacity <= 0 ||
    structuralCommandCapacity > entityCapacity
  ) {
    throw new RangeError(
      "transport.structuralCommandCapacity must be an integer between 1 and entityCapacity.",
    );
  }
  const state: EngineState = {
    config,
    worker: (config.workerFactory ?? createDefaultWorker)(),
    pendingCommands: [],
    sharedMemory: supportsSharedRuntimeMemory()
      ? allocateSharedRuntimeMemory(transformCapacity, structuralCommandCapacity)
      : undefined,
    status: "new",
    entityCapacity,
    transformCapacity,
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
  return engine;
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
    if (options.color !== undefined) validateColor(options.color);
    const entity = world.createEntity();
    world.add(entity, material(options));
    return { kind: "basic-material", id: entity } as const satisfies BasicMaterialHandle;
  };
  const defaultBasicMaterial = (): BasicMaterialHandle => {
    defaultMaterial ??= createBasicMaterial();
    return defaultMaterial;
  };
  const create: CreateApi = {
    basicMaterial: createBasicMaterial,
    mesh(options: MeshOptions) {
      validateMeshOptions(state, options);
      ensureTransformSlotAvailable(state);
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
      validateCameraOptions(options);
      ensureTransformSlotAvailable(state);
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
  };
  const set: SetApi = {
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
  };
  return {
    create,
    set,
    destroy(handle: EngineHandle) {
      world.destroyEntity(handle.id);
      if (handle === defaultMaterial) defaultMaterial = undefined;
    },
  };
}

function mutableTransform(options: {
  readonly position?: Vec3;
  readonly rotation?: Quat;
  readonly scale?: Vec3;
}): MutableTransformValue {
  if (options.position !== undefined) validateFiniteTuple("position", options.position, 3);
  if (options.rotation !== undefined) validateQuaternion(options.rotation);
  if (options.scale !== undefined) validateFiniteTuple("scale", options.scale, 3);
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
  return {
    kind,
    id: entity,
    position,
    rotation,
    scale,
  } as unknown as Kind extends "mesh" ? MeshHandle : CameraHandle;
}

function createVector3Control(
  value: [number, number, number],
  publish: () => void,
): Vector3Control {
  return {
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
      validateFiniteTuple("vector", [x, y, z], 3);
      value[0] = x;
      value[1] = y;
      value[2] = z;
      publish();
    },
  };
}

function createQuaternionControl(
  value: [number, number, number, number],
  publish: () => void,
): QuaternionControl {
  return {
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
      validateFiniteTuple("quaternion", [x, y, z, w], 4);
      value[0] = x;
      value[1] = y;
      value[2] = z;
      value[3] = w;
      publish();
    },
  };
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
  validateTransformSlot(state, entity);
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
      const entity = allocateEntity(state);
      dispatchCommand(state, { type: "spawn", entity: packEntity(entity) });
      return entity;
    },
    destroyEntity(entity: Entity) {
      validateLiveEntity(state, entity);
      dispatchCommand(state, { type: "despawn", entity: packEntity(entity) });
      releaseEntity(state, entity);
    },
    add(entity: Entity, component: Component) {
      validateLiveEntity(state, entity);
      if (component.kind === "transform") validateTransformSlot(state, entity);
      dispatchCommand(state, componentCommand(state, entity, component));
    },
    remove(entity: Entity, component: Component["kind"]) {
      validateLiveEntity(state, entity);
      dispatchCommand(state, { type: "remove-component", entity: packEntity(entity), component });
    },
  };
  return world;
}

function componentCommand(
  state: EngineState,
  entity: Entity,
  component: Component,
): RuntimeCommand {
  validateComponent(state, component);
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

function validateMeshOptions(state: EngineState, options: MeshOptions): void {
  if (options.geometry !== "cube" && options.geometry !== "triangle") {
    throw new RangeError("Mesh geometry must be 'cube' or 'triangle'.");
  }
  if (options.material !== undefined && options.material !== "basic") {
    if (options.material.kind !== "basic-material") {
      throw new TypeError("A mesh requires a basic-material handle.");
    }
    validateLiveEntity(state, options.material.id);
  }
  if (options.position !== undefined) validateFiniteTuple("position", options.position, 3);
  if (options.rotation !== undefined) validateQuaternion(options.rotation);
  if (options.scale !== undefined) validateFiniteTuple("scale", options.scale, 3);
  if (options.bounds !== undefined) {
    if (!Number.isFinite(options.bounds.radius) || options.bounds.radius < 0) {
      throw new RangeError("Mesh bounds radius must be a non-negative finite number.");
    }
    if (options.bounds.center !== undefined)
      validateFiniteTuple("bounds center", options.bounds.center, 3);
  }
}

function validateCameraOptions(options: PerspectiveCameraOptions): void {
  if (options.position !== undefined) validateFiniteTuple("position", options.position, 3);
  if (options.rotation !== undefined) validateFiniteTuple("rotation", options.rotation, 4);
  if (
    options.verticalFov !== undefined &&
    (!Number.isFinite(options.verticalFov) || options.verticalFov <= 0)
  ) {
    throw new RangeError("Camera verticalFov must be a positive finite number.");
  }
  if (options.near !== undefined && (!Number.isFinite(options.near) || options.near <= 0)) {
    throw new RangeError("Camera near must be a positive finite number.");
  }
  if (options.far !== undefined && (!Number.isFinite(options.far) || options.far <= 0)) {
    throw new RangeError("Camera far must be a positive finite number.");
  }
  if (options.near !== undefined && options.far !== undefined && options.far <= options.near) {
    throw new RangeError("Camera far must be greater than near.");
  }
}

function validateComponent(state: EngineState, component: Component): void {
  switch (component.kind) {
    case "transform":
      validateFiniteTuple("position", component.position, 3);
      validateQuaternion(component.rotation);
      validateFiniteTuple("scale", component.scale, 3);
      return;
    case "material":
      validateColor(component.color);
      return;
    case "camera":
      validateCameraOptions(component);
      return;
    case "mesh":
      if (!Number.isSafeInteger(component.geometry.id) || component.geometry.id < 0) {
        throw new RangeError("Mesh geometry id must be a non-negative safe integer.");
      }
      validateLiveEntity(state, component.material);
      return;
    case "bounds":
      validateFiniteTuple("bounds center", component.center, 3);
      if (!Number.isFinite(component.radius) || component.radius < 0) {
        throw new RangeError("Bounds radius must be a non-negative finite number.");
      }
  }
}

function validateFiniteTuple(label: string, value: readonly number[], length: number): void {
  if (value.length !== length || value.some((item) => !Number.isFinite(item))) {
    throw new RangeError(`${label} must contain exactly ${length} finite numbers.`);
  }
}

function validateQuaternion(value: Quat): void {
  validateFiniteTuple("rotation", value, 4);
  if (value.every((component) => component === 0)) {
    throw new RangeError("rotation must be non-zero.");
  }
}

function validateColor(value: Color): void {
  validateFiniteTuple("material color", value, 4);
  if (value.some((channel) => channel < 0 || channel > 1)) {
    throw new RangeError("material color channels must be between 0 and 1.");
  }
}

function ensureTransformSlotAvailable(state: EngineState): void {
  const index = peekEntityIndex(state);
  if (index >= state.transformCapacity) throw new Error("Transform capacity exhausted.");
}

function validateTransformSlot(state: EngineState, entity: Entity): void {
  if (entity.index >= state.transformCapacity) {
    throw new Error("Entity index exceeds configured transform capacity.");
  }
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
      : { powerPreference: webGpuPowerPreference(state.config.powerPreference) }),
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
      transformCapacity: state.transformCapacity,
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

function webGpuPowerPreference(preference: PowerPreference): GPUPowerPreference {
  return preference === "high" ? "high-performance" : "low-power";
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
