import { describe, expect, it, vi } from "vitest";

import type { EngineState } from "./engine/state.js";
import {
  createBasicMaterialResource,
  createResourceState,
  retireResource,
  validateResourceHandle,
} from "./resource-lifecycle.js";

describe("resource lifecycle invariants", () => {
  it("fails closed when a free-list count points outside its storage", () => {
    const resources = createResourceState(1, 1);
    resources.materials.freeSlotCount = 2;
    const postMessage = vi.fn();
    const state = {
      status: "ready",
      resources,
      commandTransaction: undefined,
      structuralFallback: true,
      sharedMemory: undefined,
      pendingCommands: [],
      worker: { postMessage },
    } as unknown as EngineState;

    expect(() => createBasicMaterialResource(state, [1, 1, 1, 1])).toThrow(
      "Resource free-list invariant violated",
    );
    expect(resources.materials.freeSlotCount).toBe(2);
    expect(resources.materials.states[0]).toBe(0);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("retires a resource slot before its packed generation can wrap", () => {
    const state = createState(2);
    const retained = createBasicMaterialResource(state, [1, 1, 1, 1]);
    retireResource(state, retained);
    for (let generation = 1; generation <= 0x0fff; generation += 1) {
      const handle = createBasicMaterialResource(state, [1, 1, 1, 1]);
      retireResource(state, handle);
    }

    expect(() => createBasicMaterialResource(state, [1, 1, 1, 1])).toThrow(
      expect.objectContaining({ code: "LUME_CAPACITY_EXHAUSTED" }),
    );
    expect(() => validateResourceHandle(state, retained, "basic-material")).toThrow("stale");
  });
});

function createState(capacity: number): EngineState {
  return {
    status: "ready",
    resources: createResourceState(capacity, 1),
    commandTransaction: undefined,
    structuralFallback: true,
    sharedMemory: undefined,
    pendingCommands: [],
    worker: { postMessage: vi.fn() },
  } as unknown as EngineState;
}
