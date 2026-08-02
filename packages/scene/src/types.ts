export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];
export type Vec4 = readonly [number, number, number, number];
export type Quat = Vec4;
export type Color = Vec4;

export interface Entity {
  readonly index: number;
  readonly generation: number;
}

export interface TransformComponent {
  readonly kind: "transform";
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly scale: Vec3;
}

export interface MaterialComponent {
  readonly kind: "material";
  readonly color: Color;
}

export interface CameraComponent {
  readonly kind: "camera";
  readonly verticalFov: number;
  readonly near: number;
  readonly far: number;
}

export interface MeshComponent {
  readonly kind: "mesh";
  readonly geometry: Geometry;
  readonly material: Entity;
}

export interface BoundsComponent {
  readonly kind: "bounds";
  readonly center: Vec3;
  readonly radius: number;
}

export type Component =
  TransformComponent | MaterialComponent | CameraComponent | MeshComponent | BoundsComponent;

export interface Geometry {
  readonly id: number;
  readonly kind: "triangle" | "box";
}
