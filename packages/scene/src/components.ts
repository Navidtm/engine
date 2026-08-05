import type {
  BoundsComponent,
  CameraComponent,
  Color,
  Entity,
  MaterialComponent,
  MeshComponent,
  Quat,
  TransformComponent,
  Vec3,
} from "./types.js";

const ZERO: Vec3 = Object.freeze([0, 0, 0]);
const ONE: Vec3 = Object.freeze([1, 1, 1]);
const IDENTITY_ROTATION: Quat = Object.freeze([0, 0, 0, 1]);
const WHITE: Color = Object.freeze([1, 1, 1, 1]);

export interface TransformOptions {
  readonly position?: Vec3;
  readonly rotation?: Quat;
  readonly scale?: Vec3;
}

export function transform(options: TransformOptions = {}): TransformComponent {
  const position = options.position ?? ZERO;
  const rotation = options.rotation ?? IDENTITY_ROTATION;
  const scale = options.scale ?? ONE;
  validateFiniteTuple("transform position", position, 3);
  validateFiniteTuple("transform scale", scale, 3);
  validateQuaternion(rotation);
  return Object.freeze({
    kind: "transform",
    position,
    rotation,
    scale,
  });
}

export interface MaterialOptions {
  readonly color?: Color;
}

export function material(options: MaterialOptions = {}): MaterialComponent {
  const color = options.color ?? WHITE;
  validateFiniteTuple("material color", color, 4);
  if (color.some((channel) => channel < 0 || channel > 1)) {
    throw new RangeError("material color channels must be between 0 and 1");
  }
  return Object.freeze({ kind: "material", color });
}

export interface CameraOptions {
  readonly verticalFov?: number;
  readonly near?: number;
  readonly far?: number;
}

export function camera(options: CameraOptions = {}): CameraComponent {
  const verticalFov = options.verticalFov ?? Math.PI / 3;
  const near = options.near ?? 0.1;
  const far = options.far ?? 1_000;
  if (!(verticalFov > 0 && verticalFov < Math.PI)) {
    throw new RangeError("verticalFov must be between 0 and PI radians");
  }
  if (!(near > 0 && far > near)) {
    throw new RangeError("camera planes must satisfy 0 < near < far");
  }
  return Object.freeze({ kind: "camera", verticalFov, near, far });
}

export function mesh(geometry: MeshComponent["geometry"], materialEntity: Entity): MeshComponent {
  return Object.freeze({ kind: "mesh", geometry, material: materialEntity });
}

export interface BoundsOptions {
  readonly center?: Vec3;
  readonly radius: number;
}

export function bounds(options: BoundsOptions): BoundsComponent {
  if (!Number.isFinite(options.radius) || options.radius < 0) {
    throw new RangeError("bounds radius must be a finite non-negative number");
  }
  const center = options.center ?? ZERO;
  validateFiniteTuple("bounds center", center, 3);
  return Object.freeze({
    kind: "bounds",
    center,
    radius: options.radius,
  });
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
