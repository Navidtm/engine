import type { EngineStats } from "@lume/runtime";
import type { Color, Component, Entity, Quat, Vec3 } from "@lume/scene";

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

/** Perspective parameters that can change without recreating the engine camera. */
export interface CameraPerspectiveOptions {
  /** Vertical field of view in radians; it must be positive and finite. */
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
  /** Optional initial state for the engine-owned active camera. */
  readonly camera?: EngineCameraOptions;
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
export type EngineHandle = BasicMaterialHandle | MeshHandle;
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

/** Convenience authoring functions available as `engine.create`. */
export interface CreateApi {
  /** Creates a color-only material handle. */
  basicMaterial(options?: BasicMaterialOptions): BasicMaterialHandle;
  /** Creates a triangle or cube mesh with transform and mesh components. */
  mesh(options: MeshOptions): MeshHandle;
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
 * engine.camera.position.set(0, 0, 3);
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
  /** Engine-owned active perspective camera. */
  readonly camera: EngineCamera;
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
