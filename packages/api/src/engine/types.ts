import type { EngineStats, RuntimeGeometryLimits } from "@lume/runtime";
import type {
  BasicMaterialHandle,
  Color,
  Component,
  Entity,
  GeometryHandle,
  Quat,
  Vec3,
} from "@lume/scene";

import type { EngineCapacities } from "../capacity.js";

export type { BasicMaterialHandle, GeometryHandle } from "@lume/scene";

/** Explicit worker geometry budgets; Milestone 7 intentionally supplies no defaults. */
export type GeometryLoadLimits = RuntimeGeometryLimits;

/** Lifecycle state exposed by an engine instance. */
export type EngineStatus =
  "new" | "initializing" | "ready" | "running" | "stopped" | "disposed" | "failed";

/** Simple application-level preference mapped to the WebGPU adapter preference. */
export type PowerPreference = "high" | "low";

/** Canvas compositing behavior without exposing the WebGPU IDL type. */
export type CanvasAlphaMode = "opaque" | "premultiplied";

/** Linear RGBA clear value accepted by the main render pass. */
export interface ClearColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

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

/** Fixed application component budgets; engine-owned reserved slots are added internally. */
export interface EngineComponentCapacityOptions {
  /** Maximum entities with transforms; defaults to `entityCapacity`. */
  readonly transforms?: number;
  /** Maximum entities with mesh-renderer components; may be zero and defaults to `entityCapacity`. */
  readonly meshRenderers?: number;
  /** Additional cameras beyond the engine-owned active camera; may be zero and defaults to `min(entityCapacity, 7)`. */
  readonly cameras?: number;
  /** Maximum entities with explicit bounds; may be zero and defaults to `entityCapacity`. */
  readonly bounds?: number;
}

/** Perspective parameters that can change without recreating the engine camera. */
export interface CameraPerspectiveOptions {
  /** Vertical field of view in radians; it must be finite and at least `0.0001`. */
  readonly verticalFov?: number;
  /** Positive distance to the near clipping plane. */
  readonly near?: number;
  /** Far clipping-plane distance; it must exceed `near`. */
  readonly far?: number;
}

/** Initial configuration for the engine-owned perspective camera. */
export interface EngineCameraOptions extends CameraPerspectiveOptions {
  /** Initial camera position. Defaults to `[0, 0, 3]`. */
  readonly position?: Vec3;
  /** Initial camera orientation quaternion. Defaults to identity. */
  readonly rotation?: Quat;
}

/** Controls for the single active camera used by the current renderer. */
export interface EngineCamera {
  /** Mutable camera position. */
  readonly position: Vector3Control;
  /** Mutable camera orientation. */
  readonly rotation: QuaternionControl;
  /** Updates one or more perspective parameters while preserving unspecified values. */
  setPerspective(options: CameraPerspectiveOptions): void;
}

/** Full configuration accepted by {@link createEngine}. */
export interface EngineConfig {
  /** Canvas transferred to the worker as an OffscreenCanvas during `init()`. */
  readonly canvas: HTMLCanvasElement;
  /** Optional self-hosted/CDN WASM URL; defaults to the artifact shipped by `@lume/runtime`. */
  readonly wasmUrl?: string | URL;
  /** Maximum application-owned entity slots, from 1 through 1,048,575. */
  readonly entityCapacity?: number;
  /** Maximum slots in each typed resource registry; defaults to `min(max(entityCapacity, 2), 1,024)`. */
  readonly resourceCapacity?: number;
  /** Explicit fixed component budgets. */
  readonly componentCapacities?: EngineComponentCapacityOptions;
  /** Optional initial state for the engine-owned active camera. */
  readonly camera?: EngineCameraOptions;
  /** Advanced SharedArrayBuffer and worker transport budgets. */
  readonly transport?: EngineTransportOptions;
  /** Required budgets when using `engine.load.geometry()`; omitted means external loading is disabled. */
  readonly geometryLimits?: GeometryLoadLimits;
  /** Prefers a high-performance (`"high"`) or power-efficient (`"low"`) adapter. */
  readonly powerPreference?: PowerPreference;
  /** Visibility backend; `auto` uses the measured CPU reference policy. */
  readonly visibilityMode?: "auto" | "cpu" | "gpu";
  /** Canvas compositing mode; opaque by default. */
  readonly alphaMode?: CanvasAlphaMode;
  /** Main render-pass clear color. */
  readonly clearColor?: ClearColor;
  /** Set false when the application controls resize timing. */
  readonly autoResize?: boolean;
  /** Worker factory hook for tests or custom embedding. */
  readonly workerFactory?: () => Worker;
  /** Receives asynchronous worker, initialization, and device-loss errors. */
  readonly onError?: (error: Error) => void;
}

/** Configuration for the overload of {@link createEngine} that receives a canvas first. */
export type EngineOptions = Omit<EngineConfig, "canvas">;

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
export type EngineHandle = BasicMaterialHandle | GeometryHandle | MeshHandle;
/** A high-level handle with a user-authored transform. */
export type SceneHandle = MeshHandle;

/** Creation options for a basic linear-RGBA material. */
export interface BasicMaterialOptions {
  /** Linear RGBA color; every channel must be finite and within `[0, 1]`. */
  readonly color?: Color;
}

/** Creation options for a built-in triangle or cube mesh. */
export interface MeshOptions {
  /** Built-in mesh geometry. */
  readonly geometry: "cube" | "triangle" | GeometryHandle;
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

/** Convenience authoring functions available as `engine.create`. */
export interface CreateApi {
  /** Creates a color-only material handle. */
  basicMaterial(options?: BasicMaterialOptions): BasicMaterialHandle;
  /** Creates a triangle or cube mesh with transform and mesh components. */
  mesh(options: MeshOptions): MeshHandle;
}

/** Engine-owned handles for the immutable built-in geometry resources. */
export interface BuiltinGeometryApi {
  readonly cube: GeometryHandle;
  readonly triangle: GeometryHandle;
}

/** Options for one independent geometry load request. */
export interface GeometryLoadOptions {
  /** Cancels worker loading; aborting after readiness has no effect. */
  readonly signal?: AbortSignal;
}

/** Asynchronous external resource loading available as `engine.load`. */
export interface LoadApi {
  /** Loads one constrained GLB geometry and resolves only after GPU residency is ready. */
  geometry(source: string | URL, options?: GeometryLoadOptions): Promise<GeometryHandle>;
}

/** Batched transform setter available as `engine.set`. */
export interface SetApi {
  /** Replaces supplied fields; an empty options object is an intentional no-op. */
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
 * engine.camera.position.set(0, 0, 3);
 * await engine.init();
 * engine.start();
 */
export interface Engine {
  /** Effective fixed authoring limits for this engine instance. */
  readonly capacities: EngineCapacities;
  /** High-level creation API. */
  readonly create: CreateApi;
  /** Worker-owned external resource loading. */
  readonly load: LoadApi;
  /** Typed handles for built-in geometry registered by this engine. */
  readonly geometry: BuiltinGeometryApi;
  /** Partial transform updates. */
  readonly set: SetApi;
  /** Advanced component API. */
  readonly world: WorldApi;
  /** Engine-owned active perspective camera. */
  readonly camera: EngineCamera;
  /** Current lifecycle state. */
  readonly status: EngineStatus;
  /** Initializes the worker, WASM core, and WebGPU renderer. */
  init(): Promise<void>;
  /** Starts the initialized worker frame loop; repeated calls are idempotent. */
  start(): void;
  /** Requests a stop; it is a no-op when no running intent exists. */
  stop(): void;
  /** Publishes the canvas size; it is a no-op before initialization and after termination. */
  resize(): void;
  /** Requests a worker statistics snapshot from an initialized engine. */
  getStats(): Promise<EngineStats>;
  /** Destroys an entity handle or retires an owned resource handle. */
  destroy(handle: EngineHandle): void;
  /** Stops and releases the engine; repeated calls are idempotent. */
  dispose(): void;
}
