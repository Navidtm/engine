import type { BasicMaterialHandle, Color, Entity, GeometryHandle } from "@lume/scene";

import { EngineCapacityError } from "./capacity.js";
import type { EngineState } from "./engine/state.js";
import { dispatchCommand } from "./engine/transport.js";
import type { BuiltinGeometryApi } from "./engine/types.js";

const RESOURCE_INDEX_BITS = 20;
const RESOURCE_INDEX_MASK = (1 << RESOURCE_INDEX_BITS) - 1;
const RESOURCE_GENERATION_MASK = (1 << (32 - RESOURCE_INDEX_BITS)) - 1;

const enum ResourceStatus {
  Empty = 0,
  Ready = 1,
  Retired = 2,
}

type ResourceKind = "geometry" | "basic-material";
type ResourceHandle = GeometryHandle | BasicMaterialHandle;

interface HandleRecord {
  readonly kind: ResourceKind;
  readonly raw: number;
  readonly ownership: "application" | "engine";
  ownerReleased: boolean;
}

interface ResourceRegistryMirror {
  readonly states: Uint8Array;
  readonly generations: Uint16Array;
  readonly usage: Uint32Array;
  readonly freeSlots: Uint32Array;
  nextSlot: number;
  freeSlotCount: number;
}

export interface ResourceState {
  readonly capacity: number;
  readonly geometry: ResourceRegistryMirror;
  readonly materials: ResourceRegistryMirror;
  readonly handles: WeakMap<object, HandleRecord>;
  readonly meshGeometry: Uint32Array;
  readonly meshMaterial: Uint32Array;
}

export interface PreparedMeshResources {
  readonly entityIndex: number;
  readonly previousGeometry: number;
  readonly previousMaterial: number;
  readonly geometry: number;
  readonly material: number;
}

/** Allocates fixed-capacity main-thread mirrors for one engine's resource identities. */
export function createResourceState(capacity: number, entityCapacity: number): ResourceState {
  return {
    capacity,
    geometry: createRegistry(capacity),
    materials: createRegistry(capacity),
    handles: new WeakMap(),
    meshGeometry: new Uint32Array(entityCapacity),
    meshMaterial: new Uint32Array(entityCapacity),
  };
}

/** Creates and publishes the two immutable built-in geometry resources. */
export function createBuiltinGeometryApi(state: EngineState): BuiltinGeometryApi {
  const triangle = createGeometry(state, "triangle");
  const cube = createGeometry(state, "cube");
  return Object.freeze({
    cube,
    triangle,
  });
}

/** Allocates a basic-material identity and publishes its replayable descriptor. */
export function createBasicMaterialResource(state: EngineState, color: Color): BasicMaterialHandle {
  const handle = allocateHandle(state, "basic-material") as BasicMaterialHandle;
  const raw = ownedRecord(state, handle).raw;
  try {
    dispatchCommand(state, { type: "create-basic-material", handle: raw, color });
  } catch (error) {
    rollbackAllocation(state.resources.materials, raw);
    throw error;
  }
  return handle;
}

/** Validates new mesh edges without changing usage counts. */
export function prepareMeshResources(
  state: EngineState,
  entity: Entity,
  geometryHandle: GeometryHandle,
  materialHandle: BasicMaterialHandle,
): PreparedMeshResources {
  const previousGeometry = state.resources.meshGeometry[entity.index] ?? 0;
  const previousMaterial = state.resources.meshMaterial[entity.index] ?? 0;
  const geometry = validateHandleForUsage(state, geometryHandle, "geometry", previousGeometry);
  const material = validateHandleForUsage(
    state,
    materialHandle,
    "basic-material",
    previousMaterial,
  );
  return { entityIndex: entity.index, previousGeometry, previousMaterial, geometry, material };
}

/** Commits usage edges after the matching structural mutation succeeded. */
export function commitMeshResources(state: EngineState, prepared: PreparedMeshResources): void {
  const resources = state.resources;
  if (prepared.geometry !== prepared.previousGeometry) {
    const geometryIndex = resourceIndex(prepared.geometry);
    resources.geometry.usage[geometryIndex] = (resources.geometry.usage[geometryIndex] ?? 0) + 1;
    releaseUsage(resources.geometry, prepared.previousGeometry);
    resources.meshGeometry[prepared.entityIndex] = prepared.geometry;
  }
  if (prepared.material !== prepared.previousMaterial) {
    const materialIndex = resourceIndex(prepared.material);
    resources.materials.usage[materialIndex] = (resources.materials.usage[materialIndex] ?? 0) + 1;
    releaseUsage(resources.materials, prepared.previousMaterial);
    resources.meshMaterial[prepared.entityIndex] = prepared.material;
  }
}

/** Releases an entity's resource edges after mesh removal or despawn succeeds. */
export function releaseMeshResources(state: EngineState, entity: Entity): void {
  const resources = state.resources;
  const geometry = resources.meshGeometry[entity.index] ?? 0;
  const material = resources.meshMaterial[entity.index] ?? 0;
  resources.meshGeometry[entity.index] = 0;
  resources.meshMaterial[entity.index] = 0;
  releaseUsage(resources.geometry, geometry);
  releaseUsage(resources.materials, material);
}

/** Returns whether the main-thread mirror currently tracks a mesh usage edge. */
export function hasMeshResources(state: EngineState, entity: Entity): boolean {
  return (state.resources.meshGeometry[entity.index] ?? 0) !== 0;
}

/** Retires an owner edge; physical destruction waits for existing mesh usage edges. */
export function retireResource(state: EngineState, handle: ResourceHandle): void {
  const record = ownedRecord(state, handle);
  if (record.ownership === "engine") {
    throw new Error("Engine-owned built-in geometry cannot be destroyed.");
  }
  if (record.ownerReleased) return;
  const registry = registryFor(state.resources, record.kind);
  const index = resourceIndex(record.raw);
  if (
    registry.states[index] !== ResourceStatus.Ready ||
    registry.generations[index] !== resourceGeneration(record.raw)
  ) {
    throw new Error("Resource handle is stale or destroyed.");
  }
  dispatchCommand(state, {
    type: "retire-resource",
    resourceKind: record.kind,
    handle: record.raw,
  });
  record.ownerReleased = true;
  registry.states[index] = ResourceStatus.Retired;
  finalizeIfUnused(registry, index);
}

/** Returns the packed resource key after ownership, kind, and lifecycle validation. */
export function validateResourceHandle(
  state: EngineState,
  handle: ResourceHandle,
  expectedKind: ResourceKind,
): number {
  return validateHandleForUsage(state, handle, expectedKind, 0);
}

/** Rejects a future resource allocation without mutating its registry. */
export function ensureResourceSlotAvailable(
  state: EngineState,
  kind: "geometry" | "basic-material",
): void {
  const registry = registryFor(state.resources, kind);
  if (registry.freeSlotCount > 0 || registry.nextSlot < state.resources.capacity) return;
  throw new EngineCapacityError(
    kind === "basic-material" ? "material" : "geometry",
    state.resources.capacity - 1,
  );
}

/** Rolls back a newly allocated, unpublished resource after transaction failure. */
export function rollbackCreatedResource(state: EngineState, handle: ResourceHandle): void {
  const record = ownedRecord(state, handle);
  const registry = registryFor(state.resources, record.kind);
  const index = resourceIndex(record.raw);
  if (registry.states[index] !== ResourceStatus.Ready || registry.usage[index] !== 0) {
    throw new Error("Cannot roll back a committed or referenced resource.");
  }
  rollbackAllocation(registry, record.raw);
  state.resources.handles.delete(handle);
}

function createGeometry(state: EngineState, builtin: "cube" | "triangle"): GeometryHandle {
  const handle = allocateHandle(state, "geometry", "engine") as GeometryHandle;
  const raw = ownedRecord(state, handle).raw;
  try {
    dispatchCommand(state, { type: "create-geometry", handle: raw, builtin });
  } catch (error) {
    rollbackAllocation(state.resources.geometry, raw);
    throw error;
  }
  return handle;
}

function allocateHandle(
  state: EngineState,
  kind: ResourceKind,
  ownership: HandleRecord["ownership"] = "application",
): ResourceHandle {
  if (state.status === "disposed" || state.status === "failed") {
    throw new Error(`Cannot create a resource on a ${state.status} engine.`);
  }
  const registry = registryFor(state.resources, kind);
  ensureResourceSlotAvailable(state, kind);
  const index =
    registry.freeSlotCount > 0
      ? reuseResourceSlot(registry, state.resources.capacity)
      : registry.nextSlot++;
  registry.states[index] = ResourceStatus.Ready;
  const generation = registry.generations[index] ?? 0;
  const handle = Object.freeze({ kind }) as ResourceHandle;
  state.resources.handles.set(handle, {
    kind,
    raw: packResource(index, generation),
    ownership,
    ownerReleased: false,
  });
  return handle;
}

function reuseResourceSlot(registry: ResourceRegistryMirror, capacity: number): number {
  const freeIndex = registry.freeSlotCount - 1;
  const index = registry.freeSlots[freeIndex];
  if (index === undefined || index >= capacity) {
    throw new Error("Resource free-list invariant violated.");
  }
  registry.freeSlotCount = freeIndex;
  return index;
}

function validateHandleForUsage(
  state: EngineState,
  handle: ResourceHandle,
  expectedKind: ResourceKind,
  existingRaw: number,
): number {
  const record = ownedRecord(state, handle);
  if (record.kind !== expectedKind) {
    throw new TypeError(`Expected a ${expectedKind} resource handle, received ${record.kind}.`);
  }
  const registry = registryFor(state.resources, record.kind);
  const index = resourceIndex(record.raw);
  const sameExistingEdge = existingRaw === record.raw;
  if (registry.generations[index] !== resourceGeneration(record.raw)) {
    throw new Error("Resource handle is stale or destroyed.");
  }
  if (registry.states[index] === ResourceStatus.Retired && sameExistingEdge) return record.raw;
  if (registry.states[index] !== ResourceStatus.Ready || record.ownerReleased) {
    throw new Error("Resource handle is retired or destroyed.");
  }
  return record.raw;
}

function ownedRecord(state: EngineState, handle: ResourceHandle): HandleRecord {
  if ((typeof handle !== "object" && typeof handle !== "function") || handle === null) {
    throw new TypeError("Resource handle does not belong to this engine.");
  }
  const record = state.resources.handles.get(handle);
  if (record === undefined) throw new Error("Resource handle does not belong to this engine.");
  return record;
}

function registryFor(resources: ResourceState, kind: ResourceKind): ResourceRegistryMirror {
  return kind === "geometry" ? resources.geometry : resources.materials;
}

function releaseUsage(registry: ResourceRegistryMirror, raw: number): void {
  if (raw === 0) return;
  const index = resourceIndex(raw);
  const count = registry.usage[index] ?? 0;
  if (count === 0) throw new Error("Resource usage mirror underflow.");
  registry.usage[index] = count - 1;
  finalizeIfUnused(registry, index);
}

function finalizeIfUnused(registry: ResourceRegistryMirror, index: number): void {
  if (registry.states[index] !== ResourceStatus.Retired || registry.usage[index] !== 0) return;
  registry.states[index] = ResourceStatus.Empty;
  const generation = registry.generations[index] ?? 0;
  if (generation === RESOURCE_GENERATION_MASK) return;
  registry.generations[index] = generation + 1;
  registry.freeSlots[registry.freeSlotCount++] = index;
}

function rollbackAllocation(registry: ResourceRegistryMirror, raw: number): void {
  const index = resourceIndex(raw);
  registry.states[index] = ResourceStatus.Empty;
  registry.freeSlots[registry.freeSlotCount++] = index;
}

function packResource(index: number, generation: number): number {
  return ((generation & RESOURCE_GENERATION_MASK) << RESOURCE_INDEX_BITS) | index;
}

function resourceIndex(raw: number): number {
  return raw & RESOURCE_INDEX_MASK;
}

function resourceGeneration(raw: number): number {
  return raw >>> RESOURCE_INDEX_BITS;
}

function createRegistry(capacity: number): ResourceRegistryMirror {
  return {
    states: new Uint8Array(capacity),
    generations: new Uint16Array(capacity),
    usage: new Uint32Array(capacity),
    freeSlots: new Uint32Array(capacity),
    nextSlot: 1,
    freeSlotCount: 0,
  };
}
