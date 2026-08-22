/** Readonly TypeScript two-component numeric vector. */
export type Vec2 = readonly [number, number];
/** Readonly TypeScript XYZ vector used for positions, scales, and bounds centers. */
export type Vec3 = readonly [number, number, number];
/** Readonly TypeScript four-component numeric vector. */
export type Vec4 = readonly [number, number, number, number];
/** XYZW quaternion. It must be finite and non-zero when used in a transform. */
export type Quat = Vec4;
/** Linear RGBA color with each channel in the inclusive `[0, 1]` range. */
export type Color = Vec4;

/** Stable entity reference shared by the public API, worker, and Rust ECS. */
export interface Entity {
  /** Reusable slot index; valid only with its matching `generation`. */
  readonly index: number;
  /** Monotonically recycled value that rejects stale references to an index. */
  readonly generation: number;
}

/** Opaque engine-owned handle for one built-in geometry resource. */
export interface GeometryHandle {
  readonly kind: "geometry";
}

/** Opaque engine-owned handle for one color-only material resource. */
export interface BasicMaterialHandle {
  readonly kind: "basic-material";
}

/** Serializable local transform descriptor. */
export interface TransformComponent {
  /** Discriminant used by `engine.world.add`. */
  readonly kind: "transform";
  /** Finite local translation in XYZ order. */
  readonly position: Vec3;
  /** Finite non-zero local orientation quaternion in XYZW order. */
  readonly rotation: Quat;
  /** Finite local XYZ scale. */
  readonly scale: Vec3;
}

/** Perspective camera descriptor; clipping planes must satisfy `0 < near < far`. */
export interface CameraComponent {
  /** Discriminant used by `engine.world.add`. */
  readonly kind: "camera";
  /** Vertical field of view in radians. */
  readonly verticalFov: number;
  /** Positive near clipping-plane distance. */
  readonly near: number;
  /** Far clipping-plane distance greater than `near`. */
  readonly far: number;
}

/** Links geometry and material descriptors to an entity. */
export interface MeshComponent {
  /** Discriminant used by `engine.world.add`. */
  readonly kind: "mesh";
  /** Built-in geometry descriptor to render. */
  readonly geometry: GeometryHandle;
  /** Live basic-material resource belonging to the same engine. */
  readonly material: BasicMaterialHandle;
}

/** World-extraction input for sphere-frustum culling. */
export interface BoundsComponent {
  /** Discriminant used by `engine.world.add`. */
  readonly kind: "bounds";
  /** Finite local-space sphere center. */
  readonly center: Vec3;
  /** Finite non-negative local-space sphere radius. */
  readonly radius: number;
}

/** Any component accepted by the advanced `engine.world.add` API. */
export type Component = TransformComponent | CameraComponent | MeshComponent | BoundsComponent;
