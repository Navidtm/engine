const QUERY_COUNT = 2;
const QUERY_BYTES = QUERY_COUNT * BigUint64Array.BYTES_PER_ELEMENT;
const READBACK_BUFFER_COUNT = 3;

export interface GpuTimestampProfiler {
  readonly querySet: GPUQuerySet | undefined;
  readonly resolveBuffer: GPUBuffer | undefined;
  readonly readbackBuffers: readonly GPUBuffer[];
  readonly pending: Uint8Array;
  readonly timestampWrites: GPURenderPassTimestampWrites | undefined;
  readonly gpuBytes: number;
  nextReadback: number;
  gpuTimeMs: number | null;
  disposed: boolean;
}

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
  const querySet = device.createQuerySet({
    label: "Lume frame timestamps",
    type: "timestamp",
    count: QUERY_COUNT,
  });
  const resolveBuffer = device.createBuffer({
    label: "Lume timestamp resolve",
    size: QUERY_BYTES,
    usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
  });
  const readbackBuffers: GPUBuffer[] = [];
  for (let index = 0; index < READBACK_BUFFER_COUNT; index += 1) {
    readbackBuffers.push(device.createBuffer({
      label: `Lume timestamp readback ${index}`,
      size: QUERY_BYTES,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    }));
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

export function encodeGpuTimestampResolve(
  profiler: GpuTimestampProfiler,
  encoder: GPUCommandEncoder,
): number {
  if (profiler.disposed || profiler.querySet === undefined || profiler.resolveBuffer === undefined) {
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

export function destroyGpuTimestampProfiler(profiler: GpuTimestampProfiler): void {
  if (profiler.disposed) return;
  profiler.disposed = true;
  profiler.querySet?.destroy();
  profiler.resolveBuffer?.destroy();
  for (const buffer of profiler.readbackBuffers) buffer.destroy();
}
