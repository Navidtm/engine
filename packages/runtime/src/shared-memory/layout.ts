/** Four-byte `LUME` marker used to reject unrelated SharedArrayBuffers. */
export const SHARED_MEMORY_MAGIC = 0x4c55_4d45;
/** Incompatible-layout version written into every transport header. */
export const SHARED_MEMORY_VERSION = 5;
/** Number of atomic 32-bit header words at the start of the buffer. */
export const SHARED_HEADER_INTS = 16;
/** Number of floats in one packed position/quaternion/scale transform slot. */
export const SHARED_TRANSFORM_FLOATS = 10;
/** Number of 32-bit words reserved by every structural ring record. */
export const STRUCTURAL_COMMAND_WORDS = 16;

/** Bit flags that select transform fields during partial shared-memory updates. */
export enum TransformField {
  /** Position `xyz` at offsets `0..2`. */
  Position = 1,
  /** Quaternion `xyzw` at offsets `3..6`. */
  Rotation = 2,
  /** Scale `xyz` at offsets `7..9`. */
  Scale = 4,
  /** Derived-matrix marker; WASM recomputes rather than receiving matrix bytes. */
  Matrix = 8,
  /** Position, rotation, scale, and matrix marker. */
  All = 15,
}

/** Atomic header-word indices shared by the main thread and worker. */
export const enum SharedHeader {
  Magic = 0,
  Version = 1,
  Capacity = 2,
  WriteEpoch = 3,
  ReadEpoch = 4,
  QueueHead = 5,
  QueueTail = 6,
  PendingCount = 7,
  OverflowCount = 8,
  CommandHead = 9,
  CommandTail = 10,
  CommandPending = 11,
  DroppedCommands = 12,
  SharedWrites = 13,
  Reserved = 14,
  CommandCapacity = 15,
}

/** Immutable byte offsets and independent capacities for one transport buffer. */
export interface SharedMemoryLayout {
  /** Number of transform slots and dirty-queue entries. */
  readonly capacity: number;
  /** Number of fixed-width structural ring records. */
  readonly commandCapacity: number;
  /** Exact required `SharedArrayBuffer.byteLength`. */
  readonly byteLength: number;
  /** Byte offset of the atomic header. */
  readonly headerByteOffset: number;
  /** Byte offset of per-slot seqlock counters. */
  readonly sequenceByteOffset: number;
  /** Byte offset of per-slot dirty claims. */
  readonly dirtyByteOffset: number;
  /** Byte offset of generation/mask publication words. */
  readonly publicationByteOffset: number;
  /** Byte offset of the transform dirty-index ring. */
  readonly queueByteOffset: number;
  /** Byte offset of packed transform floats. */
  readonly transformByteOffset: number;
  /** Byte offset shared by structural command word and float views. */
  readonly commandByteOffset: number;
}

/** Calculates the exact aligned shared-memory layout without allocating it. */
export function calculateSharedMemoryLayout(
  capacity: number,
  commandCapacity: number = capacity,
): SharedMemoryLayout {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new RangeError("Shared-memory capacity must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(commandCapacity) || commandCapacity <= 0) {
    throw new RangeError("Structural command capacity must be a positive safe integer.");
  }
  const intBytes = Int32Array.BYTES_PER_ELEMENT;
  const floatBytes = Float32Array.BYTES_PER_ELEMENT;
  const headerByteOffset = 0;
  const sequenceByteOffset = SHARED_HEADER_INTS * intBytes;
  const dirtyByteOffset = sequenceByteOffset + capacity * intBytes;
  const publicationByteOffset = dirtyByteOffset + capacity * intBytes;
  const queueByteOffset = publicationByteOffset + capacity * intBytes;
  const transformByteOffset = queueByteOffset + capacity * intBytes;
  const commandByteOffset = transformByteOffset + capacity * SHARED_TRANSFORM_FLOATS * floatBytes;
  const byteLength = commandByteOffset + commandCapacity * STRUCTURAL_COMMAND_WORDS * intBytes;
  if (!Number.isSafeInteger(byteLength)) {
    throw new RangeError("Shared-memory layout exceeds JavaScript's safe integer range.");
  }
  return Object.freeze({
    capacity,
    commandCapacity,
    byteLength,
    headerByteOffset,
    sequenceByteOffset,
    dirtyByteOffset,
    publicationByteOffset,
    queueByteOffset,
    transformByteOffset,
    commandByteOffset,
  });
}
