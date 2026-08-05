import type { Entity } from "@lume/scene";

const MAX_ENTITY_INDEX = (1 << 20) - 1;
const MAX_ENTITY_GENERATION = (1 << 12) - 1;
const ENTITY_OWNER = Symbol("lume-entity-owner");

export interface EntityLifecycleState {
  readonly entityCapacity: number;
  readonly entityGenerations: Uint16Array;
  readonly entityAlive: Uint8Array;
  readonly freeEntities: Uint32Array;
  nextEntityIndex: number;
  freeEntityCount: number;
}

type OwnedEntity = Entity & { readonly [ENTITY_OWNER]: EntityLifecycleState };

export function allocateEntity(state: EntityLifecycleState): Entity {
  const index = state.freeEntityCount > 0 ? reuseIndex(state) : nextIndex(state);
  const entity = { index, generation: state.entityGenerations[index] ?? 0 } as OwnedEntity;
  Object.defineProperty(entity, ENTITY_OWNER, { value: state });
  state.entityAlive[index] = 1;
  return Object.freeze(entity);
}

export function releaseEntity(state: EntityLifecycleState, entity: Entity): void {
  validateLiveEntity(state, entity);
  state.entityAlive[entity.index] = 0;
  state.entityGenerations[entity.index] = (entity.generation + 1) & MAX_ENTITY_GENERATION;
  state.freeEntities[state.freeEntityCount++] = entity.index;
}

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

export function packEntity(entity: Entity): number {
  return ((entity.generation << 20) | entity.index) >>> 0;
}

export function peekEntityIndex(state: EntityLifecycleState): number {
  return state.freeEntityCount > 0
    ? (state.freeEntities[state.freeEntityCount - 1] ?? state.entityCapacity)
    : state.nextEntityIndex;
}

function reuseIndex(state: EntityLifecycleState): number {
  return state.freeEntities[--state.freeEntityCount] ?? 0;
}

function nextIndex(state: EntityLifecycleState): number {
  if (state.nextEntityIndex >= state.entityCapacity || state.nextEntityIndex > MAX_ENTITY_INDEX) {
    throw new Error("Entity capacity exhausted.");
  }
  return state.nextEntityIndex++;
}
