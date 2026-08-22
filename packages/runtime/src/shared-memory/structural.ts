import type { RuntimeCommand } from "../protocol.js";
import { SharedHeader, STRUCTURAL_COMMAND_WORDS } from "./layout.js";
import type { SharedRuntimeViews } from "./views.js";

/** Stable binary opcodes for fixed-width structural command records. */
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
  CreateTriangleGeometry = 13,
  CreateCubeGeometry = 14,
  CreateBasicMaterial = 15,
  RetireGeometry = 16,
  RetireBasicMaterial = 17,
}

/** Receives one decoded structural ring entry in FIFO worker-consumer order. */
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
  words[offset + 1] = "entity" in command ? command.entity : command.handle;
  switch (command.type) {
    case "create-basic-material":
      floats.set(command.color, offset + 2);
      break;
    case "add-transform":
      floats.set(command.position, offset + 2);
      floats.set(command.rotation, offset + 5);
      floats.set(command.scale, offset + 9);
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
    case "create-geometry":
    case "retire-resource":
    case "remove-component":
      break;
  }
}

function opcodeFor(command: RuntimeCommand): StructuralOpcode {
  switch (command.type) {
    case "create-geometry":
      return command.builtin === "triangle"
        ? StructuralOpcode.CreateTriangleGeometry
        : StructuralOpcode.CreateCubeGeometry;
    case "create-basic-material":
      return StructuralOpcode.CreateBasicMaterial;
    case "retire-resource":
      return command.resourceKind === "geometry"
        ? StructuralOpcode.RetireGeometry
        : StructuralOpcode.RetireBasicMaterial;
    case "spawn":
      return StructuralOpcode.Spawn;
    case "despawn":
      return StructuralOpcode.Despawn;
    case "add-transform":
      return StructuralOpcode.AddTransform;
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
        case "camera":
          return StructuralOpcode.RemoveCamera;
        case "mesh":
          return StructuralOpcode.RemoveMesh;
        case "bounds":
          return StructuralOpcode.RemoveBounds;
      }
  }
}

/** Decodes one borrowed ring record into the worker's typed command union. */
export function decodeSharedCommand(
  opcode: StructuralOpcode,
  identity: number,
  offset: number,
  views: SharedRuntimeViews,
): RuntimeCommand {
  const floats = views.commandFloats;
  const words = views.commandWords;
  const float = (word: number): number => floats[offset + word] ?? 0;
  const integer = (word: number): number => words[offset + word] ?? 0;
  switch (opcode) {
    case StructuralOpcode.Spawn:
      return { type: "spawn", entity: identity };
    case StructuralOpcode.Despawn:
      return { type: "despawn", entity: identity };
    case StructuralOpcode.AddTransform:
      return {
        type: "add-transform",
        entity: identity,
        position: [float(2), float(3), float(4)],
        rotation: [float(5), float(6), float(7), float(8)],
        scale: [float(9), float(10), float(11)],
      };
    case StructuralOpcode.AddCamera:
      return {
        type: "add-camera",
        entity: identity,
        verticalFov: float(2),
        near: float(3),
        far: float(4),
      };
    case StructuralOpcode.AddMesh:
      return {
        type: "add-mesh",
        entity: identity,
        geometry: integer(2),
        material: integer(3),
      };
    case StructuralOpcode.AddBounds:
      return {
        type: "add-bounds",
        entity: identity,
        center: [float(2), float(3), float(4)],
        radius: float(5),
      };
    case StructuralOpcode.RemoveTransform:
      return { type: "remove-component", entity: identity, component: "transform" };
    case StructuralOpcode.RemoveCamera:
      return { type: "remove-component", entity: identity, component: "camera" };
    case StructuralOpcode.RemoveMesh:
      return { type: "remove-component", entity: identity, component: "mesh" };
    case StructuralOpcode.RemoveBounds:
      return { type: "remove-component", entity: identity, component: "bounds" };
    case StructuralOpcode.CreateTriangleGeometry:
      return { type: "create-geometry", handle: identity, builtin: "triangle" };
    case StructuralOpcode.CreateCubeGeometry:
      return { type: "create-geometry", handle: identity, builtin: "cube" };
    case StructuralOpcode.CreateBasicMaterial:
      return {
        type: "create-basic-material",
        handle: identity,
        color: [float(2), float(3), float(4), float(5)],
      };
    case StructuralOpcode.RetireGeometry:
      return { type: "retire-resource", resourceKind: "geometry", handle: identity };
    case StructuralOpcode.RetireBasicMaterial:
      return { type: "retire-resource", resourceKind: "basic-material", handle: identity };
    case StructuralOpcode.AddMaterial:
    case StructuralOpcode.RemoveMaterial:
      throw new Error("Deprecated entity-backed material opcode received.");
  }
}
