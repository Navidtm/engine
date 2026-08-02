export const SHARED_MEMORY_MAGIC = 0x4c55_4d45;
export const SHARED_MEMORY_VERSION = 4;
export const SHARED_HEADER_INTS = 15;
export const SHARED_TRANSFORM_FLOATS = 10;
export const STRUCTURAL_COMMAND_WORDS = 16;

export enum TransformField {
  Position = 1,
  Rotation = 2,
  Scale = 4,
  Matrix = 8,
  All = 15,
}

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
}

export interface SharedMemoryLayout {
  readonly capacity: number;
  readonly byteLength: number;
  readonly headerByteOffset: number;
  readonly sequenceByteOffset: number;
  readonly dirtyByteOffset: number;
  readonly publicationByteOffset: number;
  readonly queueByteOffset: number;
  readonly transformByteOffset: number;
  readonly commandByteOffset: number;
}

export function calculateSharedMemoryLayout(capacity: number): SharedMemoryLayout {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new RangeError("Shared-memory capacity must be a positive safe integer.");
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
  const byteLength = commandByteOffset + capacity * STRUCTURAL_COMMAND_WORDS * intBytes;
  if (!Number.isSafeInteger(byteLength)) {
    throw new RangeError("Shared-memory layout exceeds JavaScript's safe integer range.");
  }
  return Object.freeze({
    capacity,
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
