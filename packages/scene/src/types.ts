/** Immutable two-component numeric vector. */
export type Vec2 = readonly [number, number];
/** Immutable XYZ vector used for positions, scales, and bounds centers. */
export type Vec3 = readonly [number, number, number];
/** Immutable four-component numeric vector. */
export type Vec4 = readonly [number, number, number, number];
/** XYZW quaternion. It must be finite and non-zero when used in a transform. */
export type Quat = Vec4;
/** Linear RGBA color with each channel in the inclusive `[0, 1]` range. */
export type Color = Vec4;

/** Stable entity reference shared by the public API, worker, and Rust ECS. */
export interface Entity {
  readonly index: number;
  readonly generation: number;
}

/** Serializable local transform descriptor. */
export interface TransformComponent {
  readonly kind: "transform";
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly scale: Vec3;
}

/** Color-only material descriptor supported by the current renderer. */
export interface MaterialComponent {
  readonly kind: "material";
  readonly color: Color;
}

/** Perspective camera descriptor; clipping planes must satisfy `0 < near < far`. */
export interface CameraComponent {
  readonly kind: "camera";
  readonly verticalFov: number;
  readonly near: number;
  readonly far: number;
}

/** Links geometry and material descriptors to an entity. */
export interface MeshComponent {
  readonly kind: "mesh";
  readonly geometry: Geometry;
  readonly material: Entity;
}

/** World-extraction input for sphere-frustum culling. */
export interface BoundsComponent {
  readonly kind: "bounds";
  readonly center: Vec3;
  readonly radius: number;
}

/** Any component accepted by the advanced `engine.world.add` API. */
export type Component =
  TransformComponent | MaterialComponent | CameraComponent | MeshComponent | BoundsComponent;

/** Immutable built-in geometry identifier understood by the renderer. */
export interface Geometry {
  readonly id: number;
  readonly kind: "triangle" | "box";
}
