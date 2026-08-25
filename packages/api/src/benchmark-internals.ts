import { allocateSharedRuntimeMemory, TransformField } from "@lume/runtime";

import type { EngineState } from "./engine/state.js";
import { publishTransform } from "./engine/transport.js";
import { validateFiniteTuple } from "./engine/validation.js";
import { allocateEntity } from "./entity-lifecycle.js";
import { copyVec3, createMeshHandle, mutableTransform } from "./transform-controls.js";

export interface PositionControlBenchmark {
  set(x: number, y: number, z: number): void;
}

/** Creates the current production position-control write path for transport benchmarks. */
export function createPositionControlBenchmark(): PositionControlBenchmark {
  const { state, entity } = createBenchmarkTarget();
  return createMeshHandle(state, entity, mutableTransform({})).position;
}

/** Preserves the allocating pre-#71 path as an equivalent benchmark baseline. */
export function createAllocatingPositionControlBenchmark(): PositionControlBenchmark {
  const { state, entity } = createBenchmarkTarget();
  const value = mutableTransform({});
  return {
    set(x, y, z) {
      const next: [number, number, number] = [x, y, z];
      validateFiniteTuple("vector", next, 3);
      publishTransform(state, entity, { ...value, position: next }, TransformField.Position);
      copyVec3(value.position, next);
    },
  };
}

function createBenchmarkTarget(): {
  readonly state: EngineState;
  readonly entity: ReturnType<typeof allocateEntity>;
} {
  const entityCapacity = 2;
  const state = {
    status: "ready",
    entityCapacity,
    transformCapacity: entityCapacity,
    entityGenerations: new Uint16Array(entityCapacity),
    entityAlive: new Uint8Array(entityCapacity),
    freeEntities: new Uint32Array(entityCapacity),
    nextEntityIndex: 0,
    freeEntityCount: 0,
    sharedMemory: allocateSharedRuntimeMemory(entityCapacity),
    structuralFallback: false,
  } as EngineState;
  return { state, entity: allocateEntity(state) };
}
