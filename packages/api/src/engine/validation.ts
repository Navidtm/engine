import type { Color, Component, Quat } from "@lume/scene";

import { peekEntityIndex } from "../entity-lifecycle.js";
import { validateResourceHandle } from "../resource-lifecycle.js";
import type { EngineState } from "./state.js";
import type {
  CameraPerspectiveOptions,
  EngineCameraOptions,
  EngineConfig,
  MeshOptions,
} from "./types.js";

export interface CameraPerspective {
  verticalFov: number;
  near: number;
  far: number;
}

export interface EngineBudgets {
  readonly entityCapacity: number;
  readonly resourceCapacity: number;
  readonly transformCapacity: number;
  readonly structuralCommandCapacity: number;
}

export const DEFAULT_CAMERA_PERSPECTIVE: CameraPerspective = {
  verticalFov: Math.PI / 3,
  near: 0.1,
  far: 1_000,
};

/** Validates user-facing capacities and returns internal capacities including the reserved zero slot. */
export function resolveEngineBudgets(config: EngineConfig): EngineBudgets {
  const userEntityCapacity = config.entityCapacity ?? 4_096;
  if (
    !Number.isSafeInteger(userEntityCapacity) ||
    userEntityCapacity <= 0 ||
    userEntityCapacity >= 1 << 20
  ) {
    throw new RangeError("entityCapacity must be an integer between 1 and 1,048,575.");
  }
  const userTransformCapacity = config.transport?.transformCapacity ?? userEntityCapacity;
  const userResourceCapacity =
    config.resourceCapacity ?? Math.min(Math.max(userEntityCapacity, 2), 1_024);
  if (
    !Number.isSafeInteger(userResourceCapacity) ||
    userResourceCapacity < 2 ||
    userResourceCapacity >= 1 << 20
  ) {
    throw new RangeError("resourceCapacity must be an integer between 2 and 1,048,575.");
  }
  if (
    !Number.isSafeInteger(userTransformCapacity) ||
    userTransformCapacity <= 0 ||
    userTransformCapacity > userEntityCapacity
  ) {
    throw new RangeError(
      "transport.transformCapacity must be an integer between 1 and entityCapacity.",
    );
  }
  const structuralCommandCapacity =
    config.transport?.structuralCommandCapacity ?? Math.min(userEntityCapacity, 1_024);
  if (
    !Number.isSafeInteger(structuralCommandCapacity) ||
    structuralCommandCapacity <= 0 ||
    structuralCommandCapacity > userEntityCapacity
  ) {
    throw new RangeError(
      "transport.structuralCommandCapacity must be an integer between 1 and entityCapacity.",
    );
  }
  return {
    entityCapacity: userEntityCapacity + 1,
    resourceCapacity: userResourceCapacity + 1,
    transformCapacity: userTransformCapacity + 1,
    structuralCommandCapacity,
  };
}

export function validateEngineCameraOptions(options: EngineCameraOptions | undefined): void {
  if (options?.position !== undefined) validateFiniteTuple("camera position", options.position, 3);
  if (options?.rotation !== undefined) validateQuaternion(options.rotation);
  resolveCameraPerspective(options, DEFAULT_CAMERA_PERSPECTIVE);
}

export function resolveCameraPerspective(
  options: CameraPerspectiveOptions | undefined,
  current: CameraPerspective,
): CameraPerspective {
  const resolved = {
    verticalFov: options?.verticalFov ?? current.verticalFov,
    near: options?.near ?? current.near,
    far: options?.far ?? current.far,
  };
  validateCameraPerspective(resolved);
  return resolved;
}

export function validateMeshOptions(state: EngineState, options: MeshOptions): void {
  if (options.geometry !== "cube" && options.geometry !== "triangle") {
    validateResourceHandle(state, options.geometry, "geometry");
  }
  if (options.material !== undefined && options.material !== "basic") {
    if (options.material.kind !== "basic-material") {
      throw new TypeError("A mesh requires a basic-material handle.");
    }
    validateResourceHandle(state, options.material, "basic-material");
  }
  if (options.position !== undefined) validateFiniteTuple("position", options.position, 3);
  if (options.rotation !== undefined) validateQuaternion(options.rotation);
  if (options.scale !== undefined) validateFiniteTuple("scale", options.scale, 3);
  if (options.bounds !== undefined) {
    if (!Number.isFinite(options.bounds.radius) || options.bounds.radius < 0) {
      throw new RangeError("Mesh bounds radius must be a non-negative finite number.");
    }
    if (options.bounds.center !== undefined) {
      validateFiniteTuple("bounds center", options.bounds.center, 3);
    }
  }
}

export function validateCameraPerspective(options: CameraPerspective): void {
  if (!Number.isFinite(options.verticalFov) || options.verticalFov <= 0) {
    throw new RangeError("Camera verticalFov must be a positive finite number.");
  }
  if (!Number.isFinite(options.near) || options.near <= 0) {
    throw new RangeError("Camera near must be a positive finite number.");
  }
  if (!Number.isFinite(options.far) || options.far <= 0) {
    throw new RangeError("Camera far must be a positive finite number.");
  }
  if (options.far <= options.near) {
    throw new RangeError("Camera far must be greater than near.");
  }
}

export function validateComponent(component: Component): void {
  switch (component.kind) {
    case "transform":
      validateFiniteTuple("position", component.position, 3);
      validateQuaternion(component.rotation);
      validateFiniteTuple("scale", component.scale, 3);
      return;
    case "camera":
      validateCameraPerspective(component);
      return;
    case "mesh":
      return;
    case "bounds":
      validateFiniteTuple("bounds center", component.center, 3);
      if (!Number.isFinite(component.radius) || component.radius < 0) {
        throw new RangeError("Bounds radius must be a non-negative finite number.");
      }
  }
}

export function validateFiniteTuple(label: string, value: readonly number[], length: number): void {
  if (value.length !== length || value.some((item) => !Number.isFinite(item))) {
    throw new RangeError(`${label} must contain exactly ${length} finite numbers.`);
  }
}

export function validateQuaternion(value: Quat): void {
  validateFiniteTuple("rotation", value, 4);
  if (value.every((component) => component === 0)) {
    throw new RangeError("rotation must be non-zero.");
  }
}

export function validateColor(value: Color): void {
  validateFiniteTuple("material color", value, 4);
  if (value.some((channel) => channel < 0 || channel > 1)) {
    throw new RangeError("material color channels must be between 0 and 1.");
  }
}

export function ensureTransformSlotAvailable(state: EngineState): void {
  const index = peekEntityIndex(state);
  if (index >= state.transformCapacity) throw new Error("Transform capacity exhausted.");
}

export function validateTransformSlot(
  state: Pick<EngineState, "transformCapacity">,
  entity: { readonly index: number },
): void {
  if (entity.index >= state.transformCapacity) {
    throw new Error("Entity index exceeds configured transform capacity.");
  }
}
