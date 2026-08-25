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
    if (writeSharedTransform(state.sharedMemory, packedEntity, value, fieldMask)) return;
    state.structuralFallback = true;
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
  if (state.commandTransaction !== undefined) {
    state.commandTransaction.push(command);
    return;
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

/** Starts a cold-path high-level authoring transaction. */
export function beginCommandTransaction(state: EngineState): void {
  if (state.commandTransaction !== undefined) {
    throw new Error("Nested authoring transactions are not supported.");
  }
  state.commandTransaction = [];
}

/** Publishes all captured commands together, preserving earlier shared ordering. */
export function commitCommandTransaction(state: EngineState): void {
  const commands = state.commandTransaction;
  if (commands === undefined) throw new Error("No authoring transaction is active.");
  state.commandTransaction = undefined;
  if (commands.length === 0) return;
  if (state.status === "new" || state.status === "initializing") {
    state.pendingCommands.push(...commands);
    return;
  }
  post(state, { type: "batch", value: commands, ordered: true });
}

/** Discards captured commands before they cross the worker boundary. */
export function rollbackCommandTransaction(state: EngineState): void {
  state.commandTransaction = undefined;
}

export function post(state: Pick<EngineState, "worker">, message: MainToWorkerMessage): void {
  state.worker.postMessage(message);
}
