import type { RuntimeCommand } from "../protocol.js";
import { SharedHeader, STRUCTURAL_COMMAND_WORDS } from "./layout.js";
import type { SharedRuntimeViews } from "./views.js";

export const enum StructuralOpcode {
  Spawn = 1,
  Despawn = 2,
  AddTransform = 3,
  AddMaterial = 4,
  AddCamera = 5,
  AddMesh = 6,
  AddBounds = 7,
  RemoveTransform = 8,
  RemoveMaterial = 9,
  RemoveCamera = 10,
  RemoveMesh = 11,
  RemoveBounds = 12,
}

export type SharedCommandConsumer = (
  opcode: StructuralOpcode,
  entity: number,
  wordOffset: number,
  views: SharedRuntimeViews,
) => void;

/** Publishes one fixed-width structural command; false means the bounded ring is full. */
export function writeSharedCommand(views: SharedRuntimeViews, command: RuntimeCommand): boolean {
  if (Atomics.load(views.header, SharedHeader.CommandPending) >= views.layout.commandCapacity) {
    Atomics.add(views.header, SharedHeader.DroppedCommands, 1);
    return false;
  }
  const tail = Atomics.load(views.header, SharedHeader.CommandTail);
  const offset = tail * STRUCTURAL_COMMAND_WORDS;
  encodeCommand(views, offset, command);
  Atomics.store(views.header, SharedHeader.CommandTail, (tail + 1) % views.layout.commandCapacity);
  Atomics.add(views.header, SharedHeader.CommandPending, 1);
  Atomics.add(views.header, SharedHeader.SharedWrites, 1);
  Atomics.notify(views.header, SharedHeader.CommandPending);
  return true;
}

/** Drains structural commands in FIFO order on the worker. */
export function drainSharedCommands(
  views: SharedRuntimeViews,
  consume: SharedCommandConsumer,
): number {
  let drained = 0;
  while (Atomics.load(views.header, SharedHeader.CommandPending) > 0) {
    const head = Atomics.load(views.header, SharedHeader.CommandHead);
    const offset = head * STRUCTURAL_COMMAND_WORDS;
    const opcode = Atomics.load(views.commandWords, offset) as StructuralOpcode;
    const entity = Atomics.load(views.commandWords, offset + 1) >>> 0;
    consume(opcode, entity, offset, views);
    Atomics.store(
      views.header,
      SharedHeader.CommandHead,
      (head + 1) % views.layout.commandCapacity,
    );
    Atomics.sub(views.header, SharedHeader.CommandPending, 1);
    drained += 1;
  }
  return drained;
}

function encodeCommand(views: SharedRuntimeViews, offset: number, command: RuntimeCommand): void {
  const words = views.commandWords;
  const floats = views.commandFloats;
  words[offset] = opcodeFor(command);
  words[offset + 1] = command.entity;
  switch (command.type) {
    case "add-transform":
      floats.set(command.position, offset + 2);
      floats.set(command.rotation, offset + 5);
      floats.set(command.scale, offset + 9);
      break;
    case "add-material":
      floats.set(command.color, offset + 2);
      break;
    case "add-camera":
      floats[offset + 2] = command.verticalFov;
      floats[offset + 3] = command.near;
      floats[offset + 4] = command.far;
      break;
    case "add-mesh":
      words[offset + 2] = command.geometry;
      words[offset + 3] = command.material;
      break;
    case "add-bounds":
      floats.set(command.center, offset + 2);
      floats[offset + 5] = command.radius;
      break;
    case "spawn":
    case "despawn":
    case "remove-component":
      break;
  }
}

function opcodeFor(command: RuntimeCommand): StructuralOpcode {
  switch (command.type) {
    case "spawn":
      return StructuralOpcode.Spawn;
    case "despawn":
      return StructuralOpcode.Despawn;
    case "add-transform":
      return StructuralOpcode.AddTransform;
    case "add-material":
      return StructuralOpcode.AddMaterial;
    case "add-camera":
      return StructuralOpcode.AddCamera;
    case "add-mesh":
      return StructuralOpcode.AddMesh;
    case "add-bounds":
      return StructuralOpcode.AddBounds;
    case "remove-component":
      switch (command.component) {
        case "transform":
          return StructuralOpcode.RemoveTransform;
        case "material":
          return StructuralOpcode.RemoveMaterial;
        case "camera":
          return StructuralOpcode.RemoveCamera;
        case "mesh":
          return StructuralOpcode.RemoveMesh;
        case "bounds":
          return StructuralOpcode.RemoveBounds;
      }
  }
}
