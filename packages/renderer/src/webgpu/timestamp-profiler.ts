const QUERY_COUNT = 2;
const QUERY_BYTES = QUERY_COUNT * BigUint64Array.BYTES_PER_ELEMENT;

/** Releases a mapped WebGPU buffer without allowing cleanup errors to escape. */
export function unmapBufferSafely(buffer: GPUBuffer): boolean {
  try {
    buffer.unmap();
    return true;
  } catch {
    return false;
  }
}

/** Optional, pull-triggered timestamp-query resources for one renderer. */
export interface GpuTimestampProfiler {
  readonly querySet: GPUQuerySet | undefined;
  readonly resolveBuffer: GPUBuffer | undefined;
  readonly readbackBuffer: GPUBuffer | undefined;
  readonly timestampWrites: GPURenderPassTimestampWrites | undefined;
  readonly gpuBytes: number;
  sampleRequested: boolean;
  samplePending: boolean;
  gpuTimeMs: number | null;
  disposed: boolean;
}

/** Creates a profiler with at most one readback in flight. */
export function createGpuTimestampProfiler(device: GPUDevice): GpuTimestampProfiler {
  if (!device.features.has("timestamp-query")) {
    return {
      querySet: undefined,
      resolveBuffer: undefined,
      readbackBuffer: undefined,
      timestampWrites: undefined,
      gpuBytes: 0,
      sampleRequested: false,
      samplePending: false,
      gpuTimeMs: null,
      disposed: false,
    };
  }
  let querySet: GPUQuerySet | undefined;
  let resolveBuffer: GPUBuffer | undefined;
  let readbackBuffer: GPUBuffer | undefined;
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
    readbackBuffer = device.createBuffer({
      label: "Lume timestamp readback",
      size: QUERY_BYTES,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
  } catch (error) {
    readbackBuffer?.destroy();
    resolveBuffer?.destroy();
    querySet?.destroy();
    throw error;
  }
  return {
    querySet,
    resolveBuffer,
    readbackBuffer,
    timestampWrites: {
      querySet,
      beginningOfPassWriteIndex: 0,
      endOfPassWriteIndex: 1,
    },
    gpuBytes: QUERY_BYTES * 2,
    sampleRequested: false,
    samplePending: false,
    gpuTimeMs: null,
    disposed: false,
  };
}

/** Requests one future sample; repeated requests are coalesced while busy. */
export function requestGpuTimestampSample(profiler: GpuTimestampProfiler): boolean {
  if (
    profiler.disposed ||
    profiler.timestampWrites === undefined ||
    profiler.sampleRequested ||
    profiler.samplePending
  ) {
    return false;
  }
  profiler.sampleRequested = true;
  profiler.gpuTimeMs = null;
  return true;
}

/** Claims a requested sample for this frame without allocating frame-time state. */
export function beginGpuTimestampSample(profiler: GpuTimestampProfiler): boolean {
  if (profiler.disposed || !profiler.sampleRequested || profiler.samplePending) return false;
  profiler.sampleRequested = false;
  profiler.samplePending = true;
  return true;
}

/** Encodes resolve/copy commands for an explicitly sampled frame. */
export function encodeGpuTimestampResolve(
  profiler: GpuTimestampProfiler,
  encoder: GPUCommandEncoder,
  sampled: boolean,
): boolean {
  if (
    !sampled ||
    profiler.disposed ||
    profiler.querySet === undefined ||
    profiler.resolveBuffer === undefined ||
    profiler.readbackBuffer === undefined
  ) {
    return false;
  }
  encoder.resolveQuerySet(profiler.querySet, 0, QUERY_COUNT, profiler.resolveBuffer, 0);
  encoder.copyBufferToBuffer(profiler.resolveBuffer, 0, profiler.readbackBuffer, 0, QUERY_BYTES);
  return true;
}

/** Maps one explicitly sampled timestamp pair and updates `gpuTimeMs`. */
export function requestGpuTimestampRead(profiler: GpuTimestampProfiler, sampled: boolean): void {
  const buffer = profiler.readbackBuffer;
  if (!sampled || buffer === undefined || profiler.disposed) return;
  void buffer.mapAsync(GPUMapMode.READ).then(
    () => {
      if (profiler.disposed) return;
      try {
        const values = new BigUint64Array(buffer.getMappedRange(0, QUERY_BYTES));
        const start = values[0];
        const end = values[1];
        if (start !== undefined && end !== undefined && end >= start) {
          profiler.gpuTimeMs = Number(end - start) / 1_000_000;
        }
      } catch {
        profiler.gpuTimeMs = null;
      } finally {
        profiler.samplePending = false;
        if (!unmapBufferSafely(buffer)) profiler.gpuTimeMs = null;
      }
    },
    () => {
      if (!profiler.disposed) profiler.samplePending = false;
    },
  );
}

/** Idempotently destroys every GPU resource owned by `profiler`. */
export function destroyGpuTimestampProfiler(profiler: GpuTimestampProfiler): void {
  if (profiler.disposed) return;
  profiler.disposed = true;
  profiler.sampleRequested = false;
  profiler.querySet?.destroy();
  profiler.resolveBuffer?.destroy();
  profiler.readbackBuffer?.destroy();
}
