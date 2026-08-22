import { describe, expect, it, vi } from "vitest";

import { allocateSharedRuntimeMemory } from "./allocator.js";
import { SHARED_TRANSFORM_FLOATS, SharedHeader, TransformField } from "./layout.js";
import {
  decodeSharedCommand,
  drainSharedCommands,
  StructuralOpcode,
  writeSharedCommand,
} from "./structural.js";
import { drainSharedTransforms, writeSharedTransform } from "./synchronization.js";
import { openSharedRuntimeViews } from "./views.js";

const identity = {
  position: [0, 0, 0] as const,
  rotation: [0, 0, 0, 1] as const,
  scale: [1, 1, 1] as const,
};

describe("shared runtime memory", () => {
  it("opens a validated buffer with non-overlapping typed views", () => {
    const allocated = allocateSharedRuntimeMemory(8, 2);
    const opened = openSharedRuntimeViews(allocated.buffer);
    expect(opened.layout.capacity).toBe(8);
    expect(opened.layout.commandCapacity).toBe(2);
    expect(opened.transforms).toHaveLength(8 * SHARED_TRANSFORM_FLOATS);
    expect(opened.commandWords).toHaveLength(2 * 16);
    expect(opened.layout.sequenceByteOffset).toBeGreaterThanOrEqual(opened.header.byteLength);
    expect(opened.publications).toHaveLength(8);
  });

  it("coalesces repeated writes and drains the latest value", () => {
    const views = allocateSharedRuntimeMemory(4);
    expect(writeSharedTransform(views, 2, identity)).toBe(true);
    expect(writeSharedTransform(views, 2, { ...identity, position: [4, 5, 6] })).toBe(false);
    const scratch = new Float32Array(SHARED_TRANSFORM_FLOATS);
    const entities: number[] = [];
    const drained = drainSharedTransforms(views, scratch, (entity, fieldMask, values) => {
      entities.push(entity);
      expect(fieldMask).toBe(TransformField.All);
      expect([...values]).toEqual([4, 5, 6, 0, 0, 0, 1, 1, 1, 1]);
    });
    expect(drained).toBe(1);
    expect(entities).toEqual([2]);
    expect(Atomics.load(views.header, SharedHeader.WriteEpoch)).toBe(2);
    expect(Atomics.load(views.header, SharedHeader.ReadEpoch)).toBe(2);
  });

  it("merges partial field masks and preserves packed entity generations", () => {
    const views = allocateSharedRuntimeMemory(4);
    const entity = (7 << 20) | 2;
    expect(writeSharedTransform(views, entity, identity, TransformField.Position)).toBe(true);
    expect(
      writeSharedTransform(
        views,
        entity,
        { ...identity, rotation: [0, 1, 0, 0] },
        TransformField.Rotation,
      ),
    ).toBe(false);

    const scratch = new Float32Array(SHARED_TRANSFORM_FLOATS);
    drainSharedTransforms(views, scratch, (received, fieldMask, values) => {
      expect(received).toBe(entity);
      expect(fieldMask).toBe(TransformField.Position | TransformField.Rotation);
      expect([...values.slice(0, 7)]).toEqual([0, 0, 0, 0, 1, 0, 0]);
    });
  });

  it("discards pending field masks when an entity slot changes generation", () => {
    const views = allocateSharedRuntimeMemory(4);
    const oldEntity = (2 << 20) | 1;
    const replacement = (3 << 20) | 1;
    expect(
      writeSharedTransform(
        views,
        oldEntity,
        { ...identity, rotation: [0, 1, 0, 0] },
        TransformField.Rotation,
      ),
    ).toBe(true);
    expect(
      writeSharedTransform(
        views,
        replacement,
        { ...identity, position: [7, 8, 9] },
        TransformField.Position,
      ),
    ).toBe(false);

    const scratch = new Float32Array(SHARED_TRANSFORM_FLOATS);
    const received: Array<{ entity: number; fieldMask: number; values: number[] }> = [];
    drainSharedTransforms(views, scratch, (entity, fieldMask, values) => {
      received.push({ entity, fieldMask, values: [...values] });
    });

    expect(received).toEqual([
      {
        entity: replacement,
        fieldMask: TransformField.Position,
        values: [7, 8, 9, 0, 1, 0, 0, 0, 0, 0],
      },
    ]);
  });

  it("retries when a same-field write races the publication claim", () => {
    const views = allocateSharedRuntimeMemory(2);
    expect(
      writeSharedTransform(views, 1, { ...identity, position: [1, 2, 3] }, TransformField.Position),
    ).toBe(true);

    const compareExchange = Atomics.compareExchange.bind(Atomics);
    let injected = false;
    vi.spyOn(Atomics, "compareExchange").mockImplementation(((
      array: Int32Array,
      index: number,
      expected: number,
      replacement: number,
    ): number => {
      if (
        !injected &&
        array === views.publications &&
        index === 1 &&
        expected === TransformField.Position &&
        replacement === 0
      ) {
        injected = true;
        writeSharedTransform(
          views,
          1,
          { ...identity, position: [4, 5, 6] },
          TransformField.Position,
        );
      }
      return compareExchange(array, index, expected, replacement);
    }) as typeof Atomics.compareExchange);

    const scratch = new Float32Array(SHARED_TRANSFORM_FLOATS);
    const positions: number[][] = [];
    drainSharedTransforms(views, scratch, (_entity, fieldMask, values) => {
      expect(fieldMask).toBe(TransformField.Position);
      positions.push([...values.slice(0, 3)]);
    });

    expect(injected).toBe(true);
    expect(positions).toEqual([[4, 5, 6]]);
  });

  it("uses the full ring capacity without overflow", () => {
    const views = allocateSharedRuntimeMemory(4);
    for (let entity = 0; entity < 4; entity += 1) {
      expect(writeSharedTransform(views, entity, identity)).toBe(true);
    }
    const scratch = new Float32Array(SHARED_TRANSFORM_FLOATS);
    const visited: number[] = [];
    expect(drainSharedTransforms(views, scratch, (entity) => visited.push(entity))).toBe(4);
    expect(visited).toEqual([0, 1, 2, 3]);
    expect(Atomics.load(views.header, SharedHeader.OverflowCount)).toBe(0);
  });

  it("publishes structural commands in FIFO order and reports overflow", () => {
    const views = allocateSharedRuntimeMemory(8, 2);
    expect(writeSharedCommand(views, { type: "spawn", entity: 3 })).toBe(true);
    expect(
      writeSharedCommand(views, {
        type: "add-camera",
        entity: 3,
        verticalFov: 1.2,
        near: 0.1,
        far: 500,
      }),
    ).toBe(true);
    expect(writeSharedCommand(views, { type: "despawn", entity: 3 })).toBe(false);

    const received: number[] = [];
    drainSharedCommands(views, (opcode, entity, offset, shared) => {
      received.push(opcode, entity);
      if (opcode === StructuralOpcode.AddCamera) {
        expect(shared.commandFloats[offset + 2]).toBeCloseTo(1.2);
        expect(shared.commandFloats[offset + 4]).toBe(500);
      }
    });
    expect(received).toEqual([StructuralOpcode.Spawn, 3, StructuralOpcode.AddCamera, 3]);
    expect(Atomics.load(views.header, SharedHeader.DroppedCommands)).toBe(1);
    expect(Atomics.load(views.header, SharedHeader.CommandPending)).toBe(0);
  });

  it("round-trips typed resource commands through the structural ring", () => {
    const views = allocateSharedRuntimeMemory(8, 3);
    writeSharedCommand(views, { type: "create-geometry", handle: 2, builtin: "cube" });
    writeSharedCommand(views, {
      type: "create-basic-material",
      handle: 1,
      color: [0.25, 0.5, 0.75, 1],
    });
    writeSharedCommand(views, {
      type: "retire-resource",
      resourceKind: "basic-material",
      handle: 1,
    });
    const commands: unknown[] = [];
    drainSharedCommands(views, (opcode, identity, offset, shared) => {
      commands.push(decodeSharedCommand(opcode, identity, offset, shared));
    });
    expect(commands).toEqual([
      { type: "create-geometry", handle: 2, builtin: "cube" },
      { type: "create-basic-material", handle: 1, color: [0.25, 0.5, 0.75, 1] },
      { type: "retire-resource", resourceKind: "basic-material", handle: 1 },
    ]);
  });
});
