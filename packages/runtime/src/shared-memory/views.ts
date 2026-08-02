import {
  calculateSharedMemoryLayout,
  SHARED_HEADER_INTS,
  SHARED_MEMORY_MAGIC,
  SHARED_MEMORY_VERSION,
  SHARED_TRANSFORM_FLOATS,
  SharedHeader,
  type SharedMemoryLayout,
  STRUCTURAL_COMMAND_WORDS,
} from "./layout.js";

export interface SharedRuntimeViews {
  readonly buffer: SharedArrayBuffer;
  readonly layout: SharedMemoryLayout;
  readonly header: Int32Array<SharedArrayBuffer>;
  readonly sequences: Int32Array<SharedArrayBuffer>;
  readonly dirty: Int32Array<SharedArrayBuffer>;
  readonly publications: Int32Array<SharedArrayBuffer>;
  readonly queue: Int32Array<SharedArrayBuffer>;
  readonly transforms: Float32Array<SharedArrayBuffer>;
  readonly commandWords: Int32Array<SharedArrayBuffer>;
  readonly commandFloats: Float32Array<SharedArrayBuffer>;
}

export function createSharedRuntimeViews(
  buffer: SharedArrayBuffer,
  layout: SharedMemoryLayout,
): SharedRuntimeViews {
  if (buffer.byteLength !== layout.byteLength) {
    throw new Error(
      `Shared-memory byte length mismatch: expected ${layout.byteLength}, received ${buffer.byteLength}.`,
    );
  }
  return Object.freeze({
    buffer,
    layout,
    header: new Int32Array(buffer, layout.headerByteOffset, SHARED_HEADER_INTS),
    sequences: new Int32Array(buffer, layout.sequenceByteOffset, layout.capacity),
    dirty: new Int32Array(buffer, layout.dirtyByteOffset, layout.capacity),
    publications: new Int32Array(buffer, layout.publicationByteOffset, layout.capacity),
    queue: new Int32Array(buffer, layout.queueByteOffset, layout.capacity),
    transforms: new Float32Array(
      buffer,
      layout.transformByteOffset,
      layout.capacity * SHARED_TRANSFORM_FLOATS,
    ),
    commandWords: new Int32Array(
      buffer,
      layout.commandByteOffset,
      layout.capacity * STRUCTURAL_COMMAND_WORDS,
    ),
    commandFloats: new Float32Array(
      buffer,
      layout.commandByteOffset,
      layout.capacity * STRUCTURAL_COMMAND_WORDS,
    ),
  });
}

export function openSharedRuntimeViews(buffer: SharedArrayBuffer): SharedRuntimeViews {
  if (buffer.byteLength < SHARED_HEADER_INTS * Int32Array.BYTES_PER_ELEMENT) {
    throw new Error("Shared-memory buffer is too small to contain a runtime header.");
  }
  const header = new Int32Array(buffer, 0, SHARED_HEADER_INTS);
  if (Atomics.load(header, SharedHeader.Magic) !== SHARED_MEMORY_MAGIC) {
    throw new Error("Shared-memory runtime magic does not match.");
  }
  if (Atomics.load(header, SharedHeader.Version) !== SHARED_MEMORY_VERSION) {
    throw new Error("Shared-memory runtime version does not match.");
  }
  const capacity = Atomics.load(header, SharedHeader.Capacity);
  return createSharedRuntimeViews(buffer, calculateSharedMemoryLayout(capacity));
}
