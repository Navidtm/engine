import { SHARED_TRANSFORM_FLOATS, SharedHeader } from "./layout.js";
import type { SharedRuntimeViews } from "./views.js";

export interface SharedTransformValue {
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly scale: readonly [number, number, number];
}

export type SharedTransformConsumer = (entity: number, values: Float32Array<ArrayBuffer>) => void;

export function writeSharedTransform(
  views: SharedRuntimeViews,
  entity: number,
  value: SharedTransformValue,
): boolean {
  validateEntity(views, entity);
  Atomics.add(views.sequences, entity, 1);
  const offset = entity * SHARED_TRANSFORM_FLOATS;
  views.transforms[offset] = value.position[0];
  views.transforms[offset + 1] = value.position[1];
  views.transforms[offset + 2] = value.position[2];
  views.transforms[offset + 3] = value.rotation[0];
  views.transforms[offset + 4] = value.rotation[1];
  views.transforms[offset + 5] = value.rotation[2];
  views.transforms[offset + 6] = value.rotation[3];
  views.transforms[offset + 7] = value.scale[0];
  views.transforms[offset + 8] = value.scale[1];
  views.transforms[offset + 9] = value.scale[2];
  Atomics.add(views.sequences, entity, 1);

  let enqueued = false;
  if (Atomics.compareExchange(views.dirty, entity, 0, 1) === 0) {
    const pending = Atomics.load(views.header, SharedHeader.PendingCount);
    if (pending >= views.layout.capacity) {
      Atomics.store(views.dirty, entity, 0);
      Atomics.add(views.header, SharedHeader.OverflowCount, 1);
      return false;
    }
    const tail = Atomics.load(views.header, SharedHeader.QueueTail);
    Atomics.store(views.queue, tail, entity);
    Atomics.store(views.header, SharedHeader.QueueTail, (tail + 1) % views.layout.capacity);
    Atomics.add(views.header, SharedHeader.PendingCount, 1);
    enqueued = true;
  }
  Atomics.add(views.header, SharedHeader.WriteEpoch, 1);
  Atomics.notify(views.header, SharedHeader.WriteEpoch);
  return enqueued;
}

export function drainSharedTransforms(
  views: SharedRuntimeViews,
  scratch: Float32Array<ArrayBuffer>,
  consume: SharedTransformConsumer,
): number {
  if (scratch.length < SHARED_TRANSFORM_FLOATS) {
    throw new RangeError(`Transform scratch storage requires ${SHARED_TRANSFORM_FLOATS} floats.`);
  }
  const publishedEpoch = Atomics.load(views.header, SharedHeader.WriteEpoch);
  let drained = 0;
  while (Atomics.load(views.header, SharedHeader.PendingCount) > 0) {
    const head = Atomics.load(views.header, SharedHeader.QueueHead);
    const entity = Atomics.load(views.queue, head);
    Atomics.store(views.header, SharedHeader.QueueHead, (head + 1) % views.layout.capacity);
    Atomics.sub(views.header, SharedHeader.PendingCount, 1);
    Atomics.store(views.dirty, entity, 0);
    readStableTransform(views, entity, scratch);
    consume(entity, scratch);
    drained += 1;
  }
  Atomics.store(views.header, SharedHeader.ReadEpoch, publishedEpoch);
  return drained;
}

function readStableTransform(
  views: SharedRuntimeViews,
  entity: number,
  target: Float32Array<ArrayBuffer>,
): void {
  const sourceOffset = entity * SHARED_TRANSFORM_FLOATS;
  while (true) {
    const before = Atomics.load(views.sequences, entity);
    if ((before & 1) !== 0) continue;
    for (let index = 0; index < SHARED_TRANSFORM_FLOATS; index += 1) {
      target[index] = views.transforms[sourceOffset + index] ?? 0;
    }
    const after = Atomics.load(views.sequences, entity);
    if (before === after && (after & 1) === 0) return;
  }
}

function validateEntity(views: SharedRuntimeViews, entity: number): void {
  if (!Number.isSafeInteger(entity) || entity < 0 || entity >= views.layout.capacity) {
    throw new RangeError(`Entity ${entity} exceeds shared transform capacity.`);
  }
}
