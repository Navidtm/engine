import type { Component } from "@lume/scene";

export type CapacityKind =
  | "entity"
  | "transform"
  | "mesh-renderer"
  | "camera"
  | "material"
  | "geometry"
  | "bounds"
  | "render-instance"
  | "render-camera";

/** Actionable fixed-budget failure exposed by synchronous authoring APIs. */
export class EngineCapacityError extends RangeError {
  readonly code = "LUME_CAPACITY_EXHAUSTED";

  constructor(
    readonly capacityKind: CapacityKind,
    readonly capacity: number,
    message = `${capacityKind} capacity exhausted at ${capacity} slots. Increase the matching engine capacity or release an existing allocation.`,
  ) {
    super(message);
    this.name = "EngineCapacityError";
  }
}

/** Application-visible effective limits; engine-owned reserved slots are excluded. */
export interface EngineCapacities {
  readonly entities: number;
  readonly transforms: number;
  readonly meshRenderers: number;
  /** Advanced cameras in addition to the engine-owned active camera. */
  readonly cameras: number;
  readonly materials: number;
  readonly geometries: number;
  readonly bounds: number;
  readonly renderInstances: number;
  /** Extracted cameras in addition to the engine-owned active camera. */
  readonly renderCameras: number;
}

type ComponentKind = Component["kind"];

interface ComponentRegistryMirror {
  readonly present: Uint8Array;
  readonly capacity: number;
  readonly exposedCapacity: number;
  count: number;
}

/** Fixed API-side mirrors used to reject component exhaustion synchronously. */
export interface ComponentCapacityState {
  readonly transform: ComponentRegistryMirror;
  readonly mesh: ComponentRegistryMirror;
  readonly camera: ComponentRegistryMirror;
  readonly bounds: ComponentRegistryMirror;
}

export function createComponentCapacityState(
  entitySlots: number,
  transformSlots: number,
  cameraSlots: number,
  meshRendererSlots: number,
  boundsSlots: number,
): ComponentCapacityState {
  return {
    transform: createComponentRegistry(entitySlots, transformSlots, transformSlots - 1),
    mesh: createComponentRegistry(entitySlots, meshRendererSlots),
    camera: createComponentRegistry(entitySlots, cameraSlots, cameraSlots - 1),
    bounds: createComponentRegistry(entitySlots, boundsSlots),
  };
}

export function ensureComponentSlotAvailable(
  state: ComponentCapacityState,
  kind: ComponentKind,
  entityIndex: number,
): void {
  const registry = componentRegistry(state, kind);
  if (registry.present[entityIndex] === 1) return;
  if (registry.count >= registry.capacity) {
    throw new EngineCapacityError(componentCapacityKind(kind), registry.exposedCapacity);
  }
}

export function commitComponent(
  state: ComponentCapacityState,
  kind: ComponentKind,
  entityIndex: number,
): void {
  const registry = componentRegistry(state, kind);
  if (registry.present[entityIndex] === 1) return;
  registry.present[entityIndex] = 1;
  registry.count += 1;
}

export function removeComponentMirror(
  state: ComponentCapacityState,
  kind: ComponentKind,
  entityIndex: number,
): boolean {
  const registry = componentRegistry(state, kind);
  if (registry.present[entityIndex] !== 1) return false;
  registry.present[entityIndex] = 0;
  registry.count -= 1;
  return true;
}

export function hasComponent(
  state: ComponentCapacityState,
  kind: ComponentKind,
  entityIndex: number,
): boolean {
  return componentRegistry(state, kind).present[entityIndex] === 1;
}

export function releaseEntityComponents(state: ComponentCapacityState, entityIndex: number): void {
  removeComponentMirror(state, "transform", entityIndex);
  removeComponentMirror(state, "mesh", entityIndex);
  removeComponentMirror(state, "camera", entityIndex);
  removeComponentMirror(state, "bounds", entityIndex);
}

function createComponentRegistry(
  entitySlots: number,
  capacity: number,
  exposedCapacity = capacity,
): ComponentRegistryMirror {
  return { present: new Uint8Array(entitySlots), capacity, exposedCapacity, count: 0 };
}

function componentRegistry(
  state: ComponentCapacityState,
  kind: ComponentKind,
): ComponentRegistryMirror {
  switch (kind) {
    case "transform":
      return state.transform;
    case "mesh":
      return state.mesh;
    case "camera":
      return state.camera;
    case "bounds":
      return state.bounds;
  }
}

function componentCapacityKind(kind: ComponentKind): CapacityKind {
  return kind === "mesh" ? "mesh-renderer" : kind;
}
