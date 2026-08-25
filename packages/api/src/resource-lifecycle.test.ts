import { describe, expect, it, vi } from "vitest";

import type { EngineState } from "./engine/state.js";
import { createBasicMaterialResource, createResourceState } from "./resource-lifecycle.js";

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
});
