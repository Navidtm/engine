import {
  type MainToWorkerMessage,
  type RuntimeCommand,
  writeSharedCommand,
  writeSharedTransform,
} from "@lume/runtime";
import type { Entity } from "@lume/scene";

import { packEntity, validateLiveEntity } from "../entity-lifecycle.js";
import type { EngineState } from "./state.js";
import { validateTransformSlot } from "./validation.js";

export interface TransformValue {
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly scale: readonly [number, number, number];
}

/** Publishes a partial transform through shared memory or the ordered command path. */
export function publishTransform(
  state: EngineState,
  entity: Entity,
  value: TransformValue,
  fieldMask: number,
): void {
  if (state.status === "disposed" || state.status === "failed") {
    throw new Error(`Cannot update a ${state.status} engine.`);
  }
  validateLiveEntity(state, entity);
  validateTransformSlot(state, entity);
  const packedEntity = packEntity(entity);
  if (!state.structuralFallback && state.sharedMemory !== undefined) {
    writeSharedTransform(state.sharedMemory, packedEntity, value, fieldMask);
    return;
  }
  dispatchCommand(state, {
    type: "add-transform",
    entity: packedEntity,
    position: value.position,
    rotation: value.rotation,
    scale: value.scale,
  });
}

/** Preserves command ordering across initialization, shared memory, and fallback. */
export function dispatchCommand(state: EngineState, command: RuntimeCommand): void {
  if (state.status === "disposed" || state.status === "failed") {
    throw new Error(`Cannot update a ${state.status} engine.`);
  }
  if (state.status === "new" || state.status === "initializing") {
    state.pendingCommands.push(command);
  } else if (
    !state.structuralFallback &&
    state.sharedMemory !== undefined &&
    writeSharedCommand(state.sharedMemory, command)
  ) {
    return;
  } else {
    state.structuralFallback = true;
    post(state, { type: "command", value: command });
  }
}

export function post(state: Pick<EngineState, "worker">, message: MainToWorkerMessage): void {
  state.worker.postMessage(message);
}
