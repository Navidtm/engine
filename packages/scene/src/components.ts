import type {
  BasicMaterialHandle,
  BoundsComponent,
  CameraComponent,
  Color,
  GeometryHandle,
  MeshComponent,
  Quat,
  TransformComponent,
  Vec3,
} from "./types.js";

const ZERO = [0, 0, 0] as const satisfies Vec3;
const ONE = [1, 1, 1] as const satisfies Vec3;
const IDENTITY_ROTATION = [0, 0, 0, 1] as const satisfies Quat;
const WHITE = [1, 1, 1, 1] as const satisfies Color;

/** Optional fields for a local transform. Defaults are origin, identity rotation, and unit scale. */
export interface TransformOptions {
  /** Local XYZ translation; defaults to `[0, 0, 0]`. */
  readonly position?: Vec3;
  /** Local XYZW quaternion; defaults to identity and must be non-zero. */
  readonly rotation?: Quat;
  /** Local XYZ scale; defaults to `[1, 1, 1]`. */
  readonly scale?: Vec3;
}

/**
 * Creates a validated transform descriptor with readonly TypeScript properties.
 *
 * @throws {RangeError} When a value is non-finite or the quaternion is zero.
 * @example
 * engine.world.add(entity, transform({ position: [0, 1, -4] }));
 */
export function transform(options: TransformOptions = {}): TransformComponent {
  const position = options.position ?? ([...ZERO] as Vec3);
  const rotation = options.rotation ?? ([...IDENTITY_ROTATION] as Quat);
  const scale = options.scale ?? ([...ONE] as Vec3);
  validateFiniteTuple("transform position", position, 3);
  validateFiniteTuple("transform scale", scale, 3);
  validateQuaternion(rotation);
  return {
    kind: "transform",
    position,
    rotation,
    scale,
  } as const satisfies TransformComponent;
}

/** Options for the current color-only basic material. */
export interface MaterialOptions {
  /** Linear RGBA color in the inclusive `[0, 1]` range; defaults to white. */
  readonly color?: Color;
}

/**
 * Creates a validated linear-RGBA material descriptor with readonly TypeScript properties.
 *
 * @throws {RangeError} When a channel is non-finite or outside `[0, 1]`.
 */
export function material(options: MaterialOptions = {}): Readonly<{ color: Color }> {
  const color = options.color ?? ([...WHITE] as Color);
  validateFiniteTuple("material color", color, 4);
  if (color.some((channel) => channel < 0 || channel > 1)) {
    throw new RangeError("material color channels must be between 0 and 1");
  }
  return { color } as const;
}

/** Perspective camera options expressed in radians and world units. */
export interface CameraOptions {
  /** Vertical FOV in radians; defaults to `PI / 3`. */
  readonly verticalFov?: number;
  /** Positive near clipping plane; defaults to `0.1`. */
  readonly near?: number;
  /** Far clipping plane greater than near; defaults to `1000`. */
  readonly far?: number;
}

/** Validates the perspective projection range shared by every authoring entry point. */
export function validateCameraPerspective(value: {
  readonly verticalFov: number;
  readonly near: number;
  readonly far: number;
}): void {
  if (
    !Number.isFinite(value.verticalFov) ||
    !(value.verticalFov > 0 && value.verticalFov < Math.PI)
  ) {
    throw new RangeError("verticalFov must be a finite number between 0 and PI radians");
  }
  if (!Number.isFinite(value.near) || value.near <= 0) {
    throw new RangeError("camera near must be a positive finite number");
  }
  if (!Number.isFinite(value.far) || value.far <= value.near) {
    throw new RangeError("camera far must be finite and greater than near");
  }
}

/**
 * Creates a validated perspective-camera descriptor with readonly TypeScript properties.
 *
 * @throws {RangeError} When FOV or clipping planes are invalid.
 */
export function camera(options: CameraOptions = {}): CameraComponent {
  const verticalFov = options.verticalFov ?? Math.PI / 3;
  const near = options.near ?? 0.1;
  const far = options.far ?? 1_000;
  validateCameraPerspective({ verticalFov, near, far });
  return { kind: "camera", verticalFov, near, far } as const satisfies CameraComponent;
}

/**
 * Creates a mesh descriptor that references engine-owned geometry and material resources.
 * Handle ownership and lifecycle are checked by `engine.world.add`.
 */
export function mesh(geometry: GeometryHandle, material: BasicMaterialHandle): MeshComponent {
  return { kind: "mesh", geometry, material } as const satisfies MeshComponent;
}

/** Sphere bounds used by CPU visibility culling. */
export interface BoundsOptions {
  /** Local XYZ sphere center; defaults to the origin. */
  readonly center?: Vec3;
  /** Finite, non-negative sphere radius. */
  readonly radius: number;
}

/**
 * Creates finite sphere bounds with readonly TypeScript properties.
 *
 * @throws {RangeError} When radius is negative/non-finite or center is non-finite.
 */
export function bounds(options: BoundsOptions): BoundsComponent {
  if (!Number.isFinite(options.radius) || options.radius < 0) {
    throw new RangeError("bounds radius must be a finite non-negative number");
  }
  const center = options.center ?? ([...ZERO] as Vec3);
  validateFiniteTuple("bounds center", center, 3);
  return {
    kind: "bounds",
    center,
    radius: options.radius,
  } as const satisfies BoundsComponent;
}

function validateQuaternion(value: Quat): void {
  validateFiniteTuple("transform rotation", value, 4);
  const squaredLength = value.reduce((sum, component) => sum + component * component, 0);
  if (squaredLength === 0) throw new RangeError("transform rotation must be non-zero");
}

function validateFiniteTuple(label: string, value: readonly number[], length: number): void {
  if (value.length !== length || value.some((component) => !Number.isFinite(component))) {
    throw new RangeError(`${label} must contain exactly ${length} finite numbers`);
  }
}
