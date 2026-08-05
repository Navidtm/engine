const QUERY_COUNT = 2;
const QUERY_BYTES = QUERY_COUNT * BigUint64Array.BYTES_PER_ELEMENT;
const READBACK_BUFFER_COUNT = 3;

/** Optional timestamp-query resources and state for one renderer. */
export interface GpuTimestampProfiler {
  /** Timestamp query set, absent when the feature is unavailable. */
  readonly querySet: GPUQuerySet | undefined;
  /** GPU-only resolve buffer, absent when profiling is unavailable. */
  readonly resolveBuffer: GPUBuffer | undefined;
  /** Rotating CPU-readable result buffers. */
  readonly readbackBuffers: readonly GPUBuffer[];
  /** Per-readback in-flight flags (`1` while mapping is pending). */
  readonly pending: Uint8Array;
  /** Pass timestamp attachment, absent when profiling is unavailable. */
  readonly timestampWrites: GPURenderPassTimestampWrites | undefined;
  /** Total bytes owned by timestamp query buffers. */
  readonly gpuBytes: number;
  /** Index considered first for the next non-blocking readback. */
  nextReadback: number;
  /** Latest resolved GPU duration in milliseconds, or `null` before a result. */
  gpuTimeMs: number | null;
  /** Prevents async callbacks from touching destroyed resources. */
  disposed: boolean;
}

/** Creates a triple-buffered profiler when `timestamp-query` is available. */
export function createGpuTimestampProfiler(device: GPUDevice): GpuTimestampProfiler {
  if (!device.features.has("timestamp-query")) {
    return {
      querySet: undefined,
      resolveBuffer: undefined,
      readbackBuffers: [],
      pending: new Uint8Array(0),
      timestampWrites: undefined,
      gpuBytes: 0,
      nextReadback: 0,
      gpuTimeMs: null,
      disposed: false,
    };
  }
  let querySet: GPUQuerySet | undefined;
  let resolveBuffer: GPUBuffer | undefined;
  const readbackBuffers: GPUBuffer[] = [];
  try {
    querySet = device.createQuerySet({
      label: "Lume frame timestamps",
      type: "timestamp",
      count: QUERY_COUNT,
    });
    resolveBuffer = device.createBuffer({
      label: "Lume timestamp resolve",
      size: QUERY_BYTES,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    for (let index = 0; index < READBACK_BUFFER_COUNT; index += 1) {
      readbackBuffers.push(
        device.createBuffer({
          label: `Lume timestamp readback ${index}`,
          size: QUERY_BYTES,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        }),
      );
    }
  } catch (error) {
    for (const buffer of readbackBuffers) buffer.destroy();
    resolveBuffer?.destroy();
    querySet?.destroy();
    throw error;
  }
  return {
    querySet,
    resolveBuffer,
    readbackBuffers,
    pending: new Uint8Array(READBACK_BUFFER_COUNT),
    timestampWrites: Object.freeze({
      querySet,
      beginningOfPassWriteIndex: 0,
      endOfPassWriteIndex: 1,
    }),
    gpuBytes: QUERY_BYTES * (READBACK_BUFFER_COUNT + 1),
    nextReadback: 0,
    gpuTimeMs: null,
    disposed: false,
  };
}

/** Encodes query resolve/copy commands and returns the claimed readback index. */
/** Returns `-1` when profiling is unavailable, disposed, or all buffers are busy. */
export function encodeGpuTimestampResolve(
  profiler: GpuTimestampProfiler,
  encoder: GPUCommandEncoder,
): number {
  if (
    profiler.disposed ||
    profiler.querySet === undefined ||
    profiler.resolveBuffer === undefined
  ) {
    return -1;
  }
  for (let offset = 0; offset < profiler.readbackBuffers.length; offset += 1) {
    const index = (profiler.nextReadback + offset) % profiler.readbackBuffers.length;
    if (profiler.pending[index] !== 0) continue;
    const readback = profiler.readbackBuffers[index];
    if (readback === undefined) continue;
    profiler.pending[index] = 1;
    profiler.nextReadback = (index + 1) % profiler.readbackBuffers.length;
    encoder.resolveQuerySet(profiler.querySet, 0, QUERY_COUNT, profiler.resolveBuffer, 0);
    encoder.copyBufferToBuffer(profiler.resolveBuffer, 0, readback, 0, QUERY_BYTES);
    return index;
  }
  return -1;
}

/** Asynchronously maps one resolved timestamp pair and updates `gpuTimeMs`. */
/** Calls with a negative or unavailable index are harmless no-ops. */
export function requestGpuTimestampRead(
  profiler: GpuTimestampProfiler,
  readbackIndex: number,
): void {
  if (readbackIndex < 0) return;
  const buffer = profiler.readbackBuffers[readbackIndex];
  if (buffer === undefined) return;
  void buffer.mapAsync(GPUMapMode.READ).then(
    () => {
      if (!profiler.disposed) {
        const values = new BigUint64Array(buffer.getMappedRange(0, QUERY_BYTES));
        const start = values[0];
        const end = values[1];
        if (start !== undefined && end !== undefined && end >= start) {
          profiler.gpuTimeMs = Number(end - start) / 1_000_000;
        }
        buffer.unmap();
        profiler.pending[readbackIndex] = 0;
      }
    },
    () => {
      if (!profiler.disposed) profiler.pending[readbackIndex] = 0;
    },
  );
}

/** Idempotently destroys every GPU resource owned by `profiler`. */
export function destroyGpuTimestampProfiler(profiler: GpuTimestampProfiler): void {
  if (profiler.disposed) return;
  profiler.disposed = true;
  profiler.querySet?.destroy();
  profiler.resolveBuffer?.destroy();
  for (const buffer of profiler.readbackBuffers) buffer.destroy();
}
