import { TransformField } from "@lume/runtime";
import type { Entity, Quat, Vec3 } from "@lume/scene";

import type { EngineState } from "./engine/state.js";
import { publishTransform } from "./engine/transport.js";
import type { MeshHandle, QuaternionControl, Vector3Control } from "./engine/types.js";
import { validateFiniteTuple, validateQuaternion } from "./engine/validation.js";

/** Mutable transform backing storage shared by one handle's controls. */
export interface MutableTransformValue {
  readonly position: [number, number, number];
  readonly rotation: [number, number, number, number];
  readonly scale: [number, number, number];
}

export function mutableTransform(options: {
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

export function createMeshHandle(
  state: EngineState,
  entity: Entity,
  value: MutableTransformValue,
): MeshHandle {
  const position = createVector3Control(value.position, (next) =>
    publishTransform(state, entity, { ...value, position: next }, TransformField.Position),
  );
  const rotation = createQuaternionControl(value.rotation, (next) =>
    publishTransform(state, entity, { ...value, rotation: next }, TransformField.Rotation),
  );
  const scale = createVector3Control(value.scale, (next) =>
    publishTransform(state, entity, { ...value, scale: next }, TransformField.Scale),
  );
  return {
    kind: "mesh",
    id: entity,
    position,
    rotation,
    scale,
  };
}

export function createVector3Control(
  value: [number, number, number],
  publish: (next: [number, number, number]) => void,
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
      const next: [number, number, number] = [x, y, z];
      validateFiniteTuple("vector", next, 3);
      publish(next);
      copyVec3(value, next);
    },
  };
}

export function createQuaternionControl(
  value: [number, number, number, number],
  publish: (next: [number, number, number, number]) => void,
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
      const next: [number, number, number, number] = [x, y, z, w];
      validateQuaternion(next, "quaternion");
      publish(next);
      copyQuat(value, next);
    },
  };
}

export function copyVec3(target: [number, number, number], source: Vec3): void {
  target[0] = source[0];
  target[1] = source[1];
  target[2] = source[2];
}

export function copyQuat(target: [number, number, number, number], source: Quat): void {
  target[0] = source[0];
  target[1] = source[1];
  target[2] = source[2];
  target[3] = source[3];
}
