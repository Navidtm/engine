import {
  allocateSharedRuntimeMemory,
  drainSharedTransforms,
  type MainToWorkerMessage,
  type SharedRuntimeViews,
  TransformField,
  writeSharedCommand,
} from "@lume/runtime";
import { describe, expect, it, vi } from "vitest";

import { allocateEntity, packEntity, releaseEntity } from "../entity-lifecycle.js";
import { createResourceState } from "../resource-lifecycle.js";
import type { EngineState } from "./state.js";
import { dispatchCommand, publishTransform } from "./transport.js";

type SharedEngineState = EngineState & { readonly sharedMemory: SharedRuntimeViews };

const identity = {
  position: [0, 0, 0] as const,
  rotation: [0, 0, 0, 1] as const,
  scale: [1, 1, 1] as const,
};

describe("engine transport ordering", () => {
  it("routes transforms through the ordered message stream after structural overflow", () => {
    const { state, posted } = createState();
    const entity = allocateEntity(state);

    publishTransform(state, entity, identity, TransformField.Position);
    expect(posted).toEqual([]);
    expect(drainTransforms(state)).toBe(1);

    expect(
      writeSharedCommand(state.sharedMemory, { type: "spawn", entity: packEntity(entity) }),
    ).toBe(true);
    dispatchCommand(state, {
      type: "add-transform",
      entity: packEntity(entity),
      ...identity,
    });
    publishTransform(state, entity, { ...identity, position: [4, 5, 6] }, TransformField.Position);

    expect(state.structuralFallback).toBe(true);
    expect(drainTransforms(state)).toBe(0);
    expect(posted).toEqual([
      {
        type: "command",
        value: { type: "add-transform", entity: packEntity(entity), ...identity },
      },
      {
        type: "command",
        value: {
          type: "add-transform",
          entity: packEntity(entity),
          position: [4, 5, 6],
          rotation: identity.rotation,
          scale: identity.scale,
        },
      },
    ]);
  });

  it("keeps create, add, remove, replacement, and transform operations ordered", () => {
    const { state, posted } = createState();
    state.structuralFallback = true;
    const original = allocateEntity(state);

    dispatchCommand(state, { type: "spawn", entity: packEntity(original) });
    dispatchCommand(state, { type: "add-transform", entity: packEntity(original), ...identity });
    dispatchCommand(state, {
      type: "remove-component",
      entity: packEntity(original),
      component: "transform",
    });
    dispatchCommand(state, { type: "despawn", entity: packEntity(original) });
    releaseEntity(state, original);
    const replacement = allocateEntity(state);
    dispatchCommand(state, { type: "spawn", entity: packEntity(replacement) });
    publishTransform(
      state,
      replacement,
      { ...identity, position: [7, 8, 9] },
      TransformField.Position,
    );

    expect(replacement.index).toBe(original.index);
    expect(replacement.generation).toBe(original.generation + 1);
    expect(
      posted.map((message) =>
        message.type === "command" && "entity" in message.value
          ? [message.value.type, message.value.entity]
          : [],
      ),
    ).toEqual([
      ["spawn", packEntity(original)],
      ["add-transform", packEntity(original)],
      ["remove-component", packEntity(original)],
      ["despawn", packEntity(original)],
      ["spawn", packEntity(replacement)],
      ["add-transform", packEntity(replacement)],
    ]);
    expect(drainTransforms(state)).toBe(0);
  });
});

function createState(): {
  readonly state: SharedEngineState;
  readonly posted: MainToWorkerMessage[];
} {
  const entityCapacity = 4;
  const posted: MainToWorkerMessage[] = [];
  const worker = {
    postMessage: vi.fn((message: MainToWorkerMessage) => posted.push(message)),
  } as unknown as Worker;
  const state: SharedEngineState = {
    config: { canvas: {} as HTMLCanvasElement, autoResize: false },
    worker,
    pendingCommands: [],
    sharedMemory: allocateSharedRuntimeMemory(entityCapacity, 1),
    status: "ready",
    entityCapacity,
    transformCapacity: entityCapacity,
    entityGenerations: new Uint16Array(entityCapacity),
    entityAlive: new Uint8Array(entityCapacity),
    freeEntities: new Uint32Array(entityCapacity),
    resources: createResourceState(4, entityCapacity),
    nextEntityIndex: 0,
    freeEntityCount: 0,
    initPromise: undefined,
    resolveInit: undefined,
    rejectInit: undefined,
    resizeObserver: undefined,
    statsRequests: new Map(),
    nextStatsRequest: 1,
    structuralFallback: false,
    lifecycleEpoch: 0,
    runningIntent: false,
  };
  return { state, posted };
}

function drainTransforms(state: SharedEngineState): number {
  const scratch = new Float32Array(10);
  return drainSharedTransforms(state.sharedMemory, scratch, () => undefined);
}
