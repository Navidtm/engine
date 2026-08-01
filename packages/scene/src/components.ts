import type {
  CameraComponent,
  BoundsComponent,
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
  return Object.freeze({
    kind: "transform",
    position: options.position ?? ZERO,
    rotation: options.rotation ?? IDENTITY_ROTATION,
    scale: options.scale ?? ONE,
  });
}

export interface MaterialOptions {
  readonly color?: Color;
}

export function material(options: MaterialOptions = {}): MaterialComponent {
  return Object.freeze({ kind: "material", color: options.color ?? WHITE });
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
  return Object.freeze({
    kind: "bounds",
    center: options.center ?? ZERO,
    radius: options.radius,
  });
}
