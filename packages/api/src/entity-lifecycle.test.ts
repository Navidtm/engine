import { describe, expect, it } from "vitest";

import {
  allocateEntity,
  ensureEntitySlotAvailable,
  type EntityLifecycleState,
  releaseEntity,
  validateLiveEntity,
} from "./entity-lifecycle.js";

describe("entity lifecycle generation exhaustion", () => {
  it("retires a slot after 4096 allocations instead of aliasing generation zero", () => {
    const state = createState(2);
    const retained = allocateEntity(state);
    let current = retained;

    for (let generation = 1; generation < 4_096; generation += 1) {
      releaseEntity(state, current);
      current = allocateEntity(state);
      expect(current).toMatchObject({ index: retained.index, generation });
    }

    releaseEntity(state, current);
    const replacement = allocateEntity(state);
    expect(replacement).toMatchObject({ index: 1, generation: 0 });
    expect(() => validateLiveEntity(state, retained)).toThrow("stale");
    expect(() => validateLiveEntity(state, current)).toThrow("stale");
  });

  it("reports exhaustion after every configured slot is retired", () => {
    const state = createState(1);
    let current = allocateEntity(state);
    for (let reuse = 1; reuse < 4_096; reuse += 1) {
      releaseEntity(state, current);
      current = allocateEntity(state);
    }

    releaseEntity(state, current);
    expect(() => ensureEntitySlotAvailable(state)).toThrow(
      expect.objectContaining({ code: "LUME_CAPACITY_EXHAUSTED", capacityKind: "entity" }),
    );
    expect(() => allocateEntity(state)).toThrow(
      expect.objectContaining({ code: "LUME_CAPACITY_EXHAUSTED", capacityKind: "entity" }),
    );
  });

  it("retires the final index before it could produce the all-ones sentinel", () => {
    const capacity = 1 << 20;
    const state = createState(capacity);
    state.nextEntityIndex = capacity - 1;
    let current = allocateEntity(state);
    for (let generation = 1; generation < 4_095; generation += 1) {
      releaseEntity(state, current);
      current = allocateEntity(state);
      expect(current.generation).toBe(generation);
    }

    releaseEntity(state, current);
    expect(() => allocateEntity(state)).toThrow(
      expect.objectContaining({ code: "LUME_CAPACITY_EXHAUSTED", capacityKind: "entity" }),
    );
  });
});

function createState(entityCapacity: number): EntityLifecycleState {
  return {
    entityCapacity,
    entityGenerations: new Uint16Array(entityCapacity),
    entityAlive: new Uint8Array(entityCapacity),
    freeEntities: new Uint32Array(entityCapacity),
    nextEntityIndex: 0,
    freeEntityCount: 0,
  };
}
