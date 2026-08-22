import type { Entity } from "@lume/scene";

import { EngineCapacityError } from "./capacity.js";

const MAX_ENTITY_INDEX = (1 << 20) - 1;
const MAX_ENTITY_GENERATION = (1 << 12) - 1;
const ENTITY_OWNER = Symbol("lume-entity-owner");

/** Internal fixed-capacity allocator state owned by one engine instance. */
export interface EntityLifecycleState {
  /** Immutable maximum number of allocatable entity slots. */
  readonly entityCapacity: number;
  /** Current generation associated with each allocated slot. */
  readonly entityGenerations: Uint16Array;
  /** Liveness bit for each slot. */
  readonly entityAlive: Uint8Array;
  /** Recyclable indices stored as a LIFO free list. */
  readonly freeEntities: Uint32Array;
  /** First never-before-allocated slot index. */
  nextEntityIndex: number;
  /** Number of valid entries at the front of `freeEntities`. */
  freeEntityCount: number;
}

type OwnedEntity = Entity & { readonly [ENTITY_OWNER]: EntityLifecycleState };

/** Allocates a readonly, engine-owned generational handle without dynamic growth. */
export function allocateEntity(state: EntityLifecycleState): Entity {
  const index = state.freeEntityCount > 0 ? reuseIndex(state) : nextIndex(state);
  const entity = { index, generation: state.entityGenerations[index] ?? 0 } as OwnedEntity;
  Object.defineProperty(entity, ENTITY_OWNER, { value: state });
  state.entityAlive[index] = 1;
  return entity;
}

/** Releases a live handle, increments its generation, and returns its slot to the free list. */
export function releaseEntity(state: EntityLifecycleState, entity: Entity): void {
  validateLiveEntity(state, entity);
  state.entityAlive[entity.index] = 0;
  state.entityGenerations[entity.index] = (entity.generation + 1) & MAX_ENTITY_GENERATION;
  state.freeEntities[state.freeEntityCount++] = entity.index;
}

/** Throws when a handle is foreign, stale, malformed, or no longer live. */
export function validateLiveEntity(state: EntityLifecycleState, entity: Entity): void {
  if (
    !Number.isInteger(entity.index) ||
    !Number.isInteger(entity.generation) ||
    entity.index < 0 ||
    entity.index >= state.entityCapacity ||
    entity.generation < 0 ||
    entity.generation > MAX_ENTITY_GENERATION ||
    state.entityAlive[entity.index] !== 1 ||
    state.entityGenerations[entity.index] !== entity.generation ||
    (entity as Partial<OwnedEntity>)[ENTITY_OWNER] !== state
  )
    throw new Error("Entity handle is stale or does not belong to this engine.");
}

/** Packs the engine's 20-bit index and 12-bit generation for transport/WASM. */
export function packEntity(entity: Entity): number {
  return ((entity.generation << 20) | entity.index) >>> 0;
}

/** Returns the next reusable or fresh index without mutating lifecycle state. */
export function peekEntityIndex(state: EntityLifecycleState): number {
  return state.freeEntityCount > 0
    ? (state.freeEntities[state.freeEntityCount - 1] ?? state.entityCapacity)
    : state.nextEntityIndex;
}

/** Rejects exhaustion without mutating the allocator. */
export function ensureEntitySlotAvailable(state: EntityLifecycleState): void {
  if (peekEntityIndex(state) >= state.entityCapacity) {
    throw new EngineCapacityError("entity", state.entityCapacity - 1);
  }
}

function reuseIndex(state: EntityLifecycleState): number {
  return state.freeEntities[--state.freeEntityCount] ?? 0;
}

function nextIndex(state: EntityLifecycleState): number {
  if (state.nextEntityIndex >= state.entityCapacity || state.nextEntityIndex > MAX_ENTITY_INDEX) {
    throw new EngineCapacityError("entity", state.entityCapacity - 1);
  }
  return state.nextEntityIndex++;
}
