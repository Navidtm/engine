import {
  allocateSharedRuntimeMemory,
  drainSharedCommands,
  drainSharedTransforms,
  type MainToWorkerMessage,
  type RuntimeCommand,
  type SharedRuntimeViews,
  TransformField,
} from "@lume/runtime";
import type { Entity } from "@lume/scene";
import { describe, expect, it, vi } from "vitest";

import { createComponentCapacityState } from "../capacity.js";
import { allocateEntity, packEntity, releaseEntity } from "../entity-lifecycle.js";
import { createResourceState } from "../resource-lifecycle.js";
import type { EngineState } from "./state.js";
import { dispatchCommand, publishTransform, type TransformValue } from "./transport.js";

type SharedEngineState = EngineState & { readonly sharedMemory: SharedRuntimeViews };

interface ModelEntity {
  readonly entity: number;
  transform: MutableTransform | undefined;
}

interface MutableTransform {
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

const IDENTITY: TransformValue = {
  position: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
};
const DEFAULT_SEEDS = [0x1a2b_3c4d, 0x5eed_c0de, 0xc001_d00d, 0xffff_fffb] as const;
const STEPS = 300;

const enum ModeledOpcode {
  Spawn = 1,
  Despawn = 2,
  AddTransform = 3,
  RemoveTransform = 8,
}

describe("seeded transport state machine", () => {
  for (const seed of selectedSeeds()) {
    it(`matches the authoritative model (seed=${seed})`, () => runSeed(seed));
  }
});

function runSeed(seed: number): void {
  const random = createRandom(seed);
  const expected = new Map<number, ModelEntity>();
  const observed = new Map<number, ModelEntity>();
  const live: Entity[] = [];
  const stale: Entity[] = [];
  let orderedFallbacks = 0;
  let step = -1;

  const { state, drain } = createHarness(observed, () => {
    orderedFallbacks += 1;
  });

  const author = (command: RuntimeCommand): void => {
    applyCommand(expected, command);
    dispatchCommand(state, command);
  };
  const create = (): Entity => {
    const entity = allocateEntity(state);
    live.push(entity);
    author({ type: "spawn", entity: packEntity(entity) });
    return entity;
  };
  const addTransform = (entity: Entity, value: TransformValue): void => {
    author({ type: "add-transform", entity: packEntity(entity), ...value });
  };
  const write = (entity: Entity, value: TransformValue, mask: number): void => {
    if (state.structuralFallback) {
      applyCommand(expected, { type: "add-transform", entity: packEntity(entity), ...value });
    } else {
      applyTransform(expected, packEntity(entity), mask, value);
    }
    publishTransform(state, entity, value, mask);
  };

  try {
    // Compose reuse, cross-generation publication replacement, same-field
    // coalescing, and then a structural overflow that permanently selects the
    // ordered message stream.
    const original = create();
    addTransform(original, IDENTITY);
    write(original, { ...IDENTITY, rotation: [0, 1, 0, 0] }, TransformField.Rotation);
    author({ type: "despawn", entity: packEntity(original) });
    releaseEntity(state, original);
    live.pop();
    stale.push(original);

    const replacement = create();
    addTransform(replacement, IDENTITY);
    write(replacement, { ...IDENTITY, position: [7, 8, 9] }, TransformField.Position);
    write(replacement, { ...IDENTITY, position: [10, 11, 12] }, TransformField.Position);
    drain();

    expect(replacement).toMatchObject({ index: original.index, generation: 1 });
    expect(observed.get(packEntity(replacement))?.transform).toEqual({
      position: [10, 11, 12],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    });

    for (let command = 0; command < 6; command += 1) {
      if ((command & 1) === 0) {
        author({
          type: "remove-component",
          entity: packEntity(replacement),
          component: "transform",
        });
      } else {
        addTransform(replacement, IDENTITY);
      }
    }
    expect(state.structuralFallback).toBe(true);
    expect(orderedFallbacks).toBe(1);

    for (step = 0; step < STEPS; step += 1) {
      const operation = random() % 10;
      if (operation === 0 && live.length < state.entityCapacity) {
        create();
      } else if (operation === 1 && live.length > 0) {
        const liveIndex = random() % live.length;
        const entity = live[liveIndex];
        if (entity === undefined) continue;
        author({ type: "despawn", entity: packEntity(entity) });
        releaseEntity(state, entity);
        live.splice(liveIndex, 1);
        stale.push(entity);
      } else if (operation === 2 && live.length > 0) {
        addTransform(pick(live, random), generatedTransform(random));
      } else if (operation === 3 && live.length > 0) {
        const entity = pick(live, random);
        author({ type: "remove-component", entity: packEntity(entity), component: "transform" });
      } else if (operation >= 4 && operation <= 7 && live.length > 0) {
        const entity = pick(live, random);
        if (expected.get(packEntity(entity))?.transform === undefined)
          addTransform(entity, IDENTITY);
        const mask = 1 << (random() % 3);
        const first = generatedTransform(random);
        write(entity, first, mask);
        if (operation === 7) write(entity, generatedTransform(random), mask);
      } else if (operation === 8) {
        drain();
      } else if (stale.length > 0) {
        const entity = pick(stale, random);
        expect(() => publishTransform(state, entity, IDENTITY, TransformField.Position)).toThrow(
          "stale",
        );
      }
    }

    drain();
    expect(snapshot(observed)).toEqual(snapshot(expected));
    expect(orderedFallbacks).toBeGreaterThan(0);
  } catch (cause) {
    throw new Error(`Transport state machine failed (seed=${seed}, step=${step}).`, { cause });
  }
}

function createHarness(
  observed: Map<number, ModelEntity>,
  onOrderedFallback: () => void,
): { readonly state: SharedEngineState; readonly drain: () => void } {
  const entityCapacity = 8;
  const sharedMemory = allocateSharedRuntimeMemory(entityCapacity, 5);
  const scratch = new Float32Array(10);
  const drain = (): void => {
    drainSharedCommands(sharedMemory, (opcode, identity, offset, views) => {
      applyCommand(observed, decodeModeledCommand(opcode, identity, offset, views));
    });
    drainSharedTransforms(sharedMemory, scratch, (entity, mask, values) => {
      applyTransform(observed, entity, mask, {
        position: [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0],
        rotation: [values[3] ?? 0, values[4] ?? 0, values[5] ?? 0, values[6] ?? 0],
        scale: [values[7] ?? 0, values[8] ?? 0, values[9] ?? 0],
      });
    });
  };
  const worker = {
    postMessage: vi.fn((message: MainToWorkerMessage) => {
      if (message.type === "command") {
        onOrderedFallback();
        drain();
        applyCommand(observed, message.value);
      } else if (message.type === "batch") {
        if (message.ordered === true) drain();
        for (const command of message.value) applyCommand(observed, command);
      }
    }),
  } as unknown as Worker;
  const state: SharedEngineState = {
    config: { canvas: {} as HTMLCanvasElement, autoResize: false },
    worker,
    pendingCommands: [],
    sharedMemory,
    status: "ready",
    entityCapacity,
    transformCapacity: entityCapacity,
    meshRendererCapacity: entityCapacity,
    cameraCapacity: entityCapacity,
    boundsCapacity: entityCapacity,
    entityGenerations: new Uint16Array(entityCapacity),
    entityAlive: new Uint8Array(entityCapacity),
    freeEntities: new Uint32Array(entityCapacity),
    resources: createResourceState(8, entityCapacity),
    components: createComponentCapacityState(
      entityCapacity,
      entityCapacity,
      entityCapacity,
      entityCapacity,
      entityCapacity,
    ),
    capacities: {
      entities: entityCapacity,
      transforms: entityCapacity,
      meshRenderers: entityCapacity,
      cameras: entityCapacity,
      materials: 8,
      geometries: 8,
      bounds: entityCapacity,
      renderInstances: entityCapacity,
      renderCameras: entityCapacity,
    },
    commandTransaction: undefined,
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
  return { state, drain };
}

function decodeModeledCommand(
  opcode: number,
  entity: number,
  offset: number,
  views: SharedRuntimeViews,
): RuntimeCommand {
  const float = (word: number): number => views.commandFloats[offset + word] ?? 0;
  switch (opcode) {
    case ModeledOpcode.Spawn:
      return { type: "spawn", entity };
    case ModeledOpcode.Despawn:
      return { type: "despawn", entity };
    case ModeledOpcode.AddTransform:
      return {
        type: "add-transform",
        entity,
        position: [float(2), float(3), float(4)],
        rotation: [float(5), float(6), float(7), float(8)],
        scale: [float(9), float(10), float(11)],
      };
    case ModeledOpcode.RemoveTransform:
      return { type: "remove-component", entity, component: "transform" };
    default:
      throw new Error(`Unexpected modeled structural opcode ${opcode}.`);
  }
}

function applyCommand(model: Map<number, ModelEntity>, command: RuntimeCommand): void {
  switch (command.type) {
    case "spawn":
      model.set(command.entity, { entity: command.entity, transform: undefined });
      break;
    case "despawn":
      model.delete(command.entity);
      break;
    case "add-transform": {
      const entity = model.get(command.entity);
      if (entity !== undefined) entity.transform = cloneTransform(command);
      break;
    }
    case "remove-component":
      if (command.component === "transform") {
        const entity = model.get(command.entity);
        if (entity !== undefined) entity.transform = undefined;
      }
      break;
    case "add-camera":
    case "add-mesh":
    case "add-bounds":
    case "create-geometry":
    case "create-basic-material":
    case "retire-resource":
      break;
  }
}

function applyTransform(
  model: Map<number, ModelEntity>,
  entityId: number,
  mask: number,
  value: TransformValue,
): void {
  const transform = model.get(entityId)?.transform;
  if (transform === undefined) return;
  if ((mask & TransformField.Position) !== 0) transform.position = [...value.position];
  if ((mask & TransformField.Rotation) !== 0) transform.rotation = [...value.rotation];
  if ((mask & TransformField.Scale) !== 0) transform.scale = [...value.scale];
}

function generatedTransform(random: () => number): TransformValue {
  const next = (): number => (random() % 31) - 15;
  return {
    position: [next(), next(), next()],
    rotation: [next(), next(), next(), next()],
    scale: [next(), next(), next()],
  };
}

function cloneTransform(value: TransformValue): MutableTransform {
  return {
    position: [...value.position],
    rotation: [...value.rotation],
    scale: [...value.scale],
  };
}

function snapshot(model: Map<number, ModelEntity>): ModelEntity[] {
  return [...model.values()]
    .map((entity) => ({
      entity: entity.entity,
      transform: entity.transform === undefined ? undefined : cloneTransform(entity.transform),
    }))
    .sort((left, right) => left.entity - right.entity);
}

function pick<T>(values: readonly T[], random: () => number): T {
  const value = values[random() % values.length];
  if (value === undefined) throw new Error("Cannot choose from an empty state-machine collection.");
  return value;
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function selectedSeeds(): readonly number[] {
  const configured = process.env.LUME_TEST_SEED;
  if (configured === undefined) return DEFAULT_SEEDS;
  const seed = Number(configured);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error("LUME_TEST_SEED must be an unsigned 32-bit integer.");
  }
  return [seed];
}
