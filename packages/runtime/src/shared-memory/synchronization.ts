import { SHARED_TRANSFORM_FLOATS, SharedHeader, TransformField } from "./layout.js";
import type { SharedRuntimeViews } from "./views.js";

const PUBLICATION_MASK_BITS = 4;
const PUBLICATION_FIELD_MASK = (1 << PUBLICATION_MASK_BITS) - 1;

/** Complete transform value; only fields named by the mask are read on write. */
export interface SharedTransformValue {
  /** Position used only when the position flag is set. */
  readonly position: readonly [number, number, number];
  /** Unit quaternion used only when the rotation flag is set. */
  readonly rotation: readonly [number, number, number, number];
  /** Scale used only when the scale flag is set. */
  readonly scale: readonly [number, number, number];
}

/** Receives one stable transform publication from the single worker consumer. */
export type SharedTransformConsumer = (
  entity: number,
  fieldMask: number,
  values: Float32Array<ArrayBuffer>,
) => void;

/**
 * Publishes selected transform fields into a seqlock slot.
 * Returns true when the publication is newly enqueued or coalesced into an
 * existing dirty slot. Returns false only when a producer/consumer race finds
 * the bounded queue full after the slot write; that newest value remains in the
 * SAB slot but is not queued, and `OverflowCount` is incremented.
 */
export function writeSharedTransform(
  views: SharedRuntimeViews,
  entity: number,
  value: SharedTransformValue,
  fieldMask: number = TransformField.All,
): boolean {
  return writeSharedTransformFields(
    views,
    entity,
    value.position,
    value.rotation,
    value.scale,
    fieldMask,
  );
}

/** Publishes transform fields without materializing a temporary aggregate value. */
export function writeSharedTransformFields(
  views: SharedRuntimeViews,
  entity: number,
  position: SharedTransformValue["position"],
  rotation: SharedTransformValue["rotation"],
  scale: SharedTransformValue["scale"],
  fieldMask: number = TransformField.All,
): boolean {
  const index = entity & 0x000f_ffff;
  validateEntity(views, index);
  if ((fieldMask & ~TransformField.All) !== 0 || fieldMask === 0) {
    throw new RangeError(`Invalid transform field mask ${fieldMask}.`);
  }
  Atomics.add(views.sequences, index, 1);
  const offset = index * SHARED_TRANSFORM_FLOATS;
  if ((fieldMask & TransformField.Position) !== 0) {
    views.transforms[offset] = position[0];
    views.transforms[offset + 1] = position[1];
    views.transforms[offset + 2] = position[2];
  }
  if ((fieldMask & TransformField.Rotation) !== 0) {
    views.transforms[offset + 3] = rotation[0];
    views.transforms[offset + 4] = rotation[1];
    views.transforms[offset + 5] = rotation[2];
    views.transforms[offset + 6] = rotation[3];
  }
  if ((fieldMask & TransformField.Scale) !== 0) {
    views.transforms[offset + 7] = scale[0];
    views.transforms[offset + 8] = scale[1];
    views.transforms[offset + 9] = scale[2];
  }
  publishGenerationAndMask(views, index, entity >>> 20, fieldMask);
  Atomics.add(views.sequences, index, 1);

  if (Atomics.compareExchange(views.dirty, index, 0, 1) === 0) {
    const pending = Atomics.load(views.header, SharedHeader.PendingCount);
    if (pending >= views.layout.capacity) {
      Atomics.store(views.dirty, index, 0);
      Atomics.add(views.header, SharedHeader.OverflowCount, 1);
      return false;
    }
    const tail = Atomics.load(views.header, SharedHeader.QueueTail);
    Atomics.store(views.queue, tail, index);
    Atomics.store(views.header, SharedHeader.QueueTail, (tail + 1) % views.layout.capacity);
    Atomics.add(views.header, SharedHeader.PendingCount, 1);
  }
  Atomics.add(views.header, SharedHeader.WriteEpoch, 1);
  Atomics.add(views.header, SharedHeader.SharedWrites, 1);
  Atomics.notify(views.header, SharedHeader.WriteEpoch);
  return true;
}

/** Drains stable transform publications on the single worker consumer. */
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
    const index = Atomics.load(views.queue, head);
    Atomics.store(views.header, SharedHeader.QueueHead, (head + 1) % views.layout.capacity);
    Atomics.sub(views.header, SharedHeader.PendingCount, 1);
    while (true) {
      const publication = claimStableTransform(views, index, scratch);
      Atomics.store(views.dirty, index, 0);
      if (publication.fieldMask !== 0) {
        consume((publication.generation << 20) | index, publication.fieldMask, scratch);
      }
      drained += 1;

      // A producer may have published while this slot was still owned by the
      // consumer and therefore could not enqueue it. Reclaim that publication
      // inline so QueueTail remains exclusively producer-owned. If the producer
      // wins this CAS, it also owns the corresponding queue publication.
      if (
        publicationFieldMask(Atomics.load(views.publications, index)) === 0 ||
        Atomics.compareExchange(views.dirty, index, 0, 1) !== 0
      ) {
        break;
      }
    }
  }
  Atomics.store(views.header, SharedHeader.ReadEpoch, publishedEpoch);
  return drained;
}

function publishGenerationAndMask(
  views: SharedRuntimeViews,
  index: number,
  generation: number,
  fieldMask: number,
): void {
  while (true) {
    const current = Atomics.load(views.publications, index);
    const currentGeneration = publicationGeneration(current);
    const mergedMask =
      (currentGeneration === generation ? publicationFieldMask(current) : 0) | fieldMask;
    const next = packPublication(generation, mergedMask);
    if (Atomics.compareExchange(views.publications, index, current, next) === current) return;
  }
}

function claimStableTransform(
  views: SharedRuntimeViews,
  index: number,
  target: Float32Array<ArrayBuffer>,
): { readonly generation: number; readonly fieldMask: number } {
  const sourceOffset = index * SHARED_TRANSFORM_FLOATS;
  while (true) {
    const before = Atomics.load(views.sequences, index);
    if ((before & 1) !== 0) continue;
    const publication = Atomics.load(views.publications, index);
    for (let valueIndex = 0; valueIndex < SHARED_TRANSFORM_FLOATS; valueIndex += 1) {
      target[valueIndex] = views.transforms[sourceOffset + valueIndex] ?? 0;
    }
    const after = Atomics.load(views.sequences, index);
    if (before !== after || (after & 1) !== 0) continue;

    const generation = publicationGeneration(publication);
    const fieldMask = publicationFieldMask(publication);
    const claimed = packPublication(generation, 0);
    if (Atomics.compareExchange(views.publications, index, publication, claimed) !== publication) {
      continue;
    }

    // An idempotent producer OR can leave the publication word unchanged. The
    // sequence check detects that write; restoring the claimed bits makes the
    // retry observe it. A generation change cannot be overwritten by this CAS
    // because the generation occupies the same atomic word.
    if (Atomics.load(views.sequences, index) !== after) {
      const current = Atomics.load(views.publications, index);
      if (publicationGeneration(current) === generation) {
        Atomics.or(views.publications, index, fieldMask);
      }
      continue;
    }
    return { generation, fieldMask };
  }
}

function packPublication(generation: number, fieldMask: number): number {
  return (generation << PUBLICATION_MASK_BITS) | fieldMask;
}

function publicationGeneration(publication: number): number {
  return publication >>> PUBLICATION_MASK_BITS;
}

function publicationFieldMask(publication: number): number {
  return publication & PUBLICATION_FIELD_MASK;
}

function validateEntity(views: SharedRuntimeViews, entity: number): void {
  if (!Number.isSafeInteger(entity) || entity < 0 || entity >= views.layout.capacity) {
    throw new RangeError(`Entity ${entity} exceeds shared transform capacity.`);
  }
}
