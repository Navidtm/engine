import { afterEach, describe, expect, it, vi } from "vitest";

import {
  beginGpuTimestampSample,
  createGpuTimestampProfiler,
  destroyGpuTimestampProfiler,
  encodeGpuTimestampResolve,
  requestGpuTimestampRead,
  requestGpuTimestampSample,
} from "./timestamp-profiler.js";

afterEach(() => vi.unstubAllGlobals());

function installGpuConstants(): void {
  vi.stubGlobal("GPUBufferUsage", {
    QUERY_RESOLVE: 1,
    COPY_SRC: 2,
    MAP_READ: 4,
    COPY_DST: 8,
  });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
}

function createSupportedFixture(mapAsync = vi.fn(() => Promise.resolve())) {
  installGpuConstants();
  const querySet = { destroy: vi.fn() };
  const timestampBytes = new BigUint64Array([2_000_000n, 5_500_000n]);
  const buffers: Array<{
    readonly size: number;
    readonly destroy: ReturnType<typeof vi.fn>;
    readonly mapAsync: ReturnType<typeof vi.fn>;
    readonly getMappedRange: ReturnType<typeof vi.fn>;
    readonly unmap: ReturnType<typeof vi.fn>;
  }> = [];
  const device = {
    features: new Set<GPUFeatureName>(["timestamp-query"]),
    createQuerySet: vi.fn(() => querySet),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      const buffer = {
        size: Number(descriptor.size),
        destroy: vi.fn(),
        mapAsync,
        getMappedRange: vi.fn(() => timestampBytes.buffer),
        unmap: vi.fn(),
      };
      buffers.push(buffer);
      return buffer;
    }),
  } as unknown as GPUDevice;
  return { device, querySet, buffers, mapAsync };
}

describe("GPU timestamp profiler", () => {
  it("stays disabled when timestamp queries are unavailable", () => {
    const device = {
      features: new Set<GPUFeatureName>(),
      createBuffer: vi.fn(),
      createQuerySet: vi.fn(),
    } as unknown as GPUDevice;
    const profiler = createGpuTimestampProfiler(device);

    expect(requestGpuTimestampSample(profiler)).toBe(false);
    expect(beginGpuTimestampSample(profiler)).toBe(false);
    expect(profiler.gpuTimeMs).toBeNull();
    expect(device.createBuffer).not.toHaveBeenCalled();
  });

  it("does not map during normal frames and coalesces requests while pending", () => {
    const { device, mapAsync } = createSupportedFixture();
    const profiler = createGpuTimestampProfiler(device);
    const encoder = {
      resolveQuerySet: vi.fn(),
      copyBufferToBuffer: vi.fn(),
    } as unknown as GPUCommandEncoder;

    expect(beginGpuTimestampSample(profiler)).toBe(false);
    expect(encodeGpuTimestampResolve(profiler, encoder, false)).toBe(false);
    requestGpuTimestampRead(profiler, false);
    expect(mapAsync).not.toHaveBeenCalled();

    expect(requestGpuTimestampSample(profiler)).toBe(true);
    expect(beginGpuTimestampSample(profiler)).toBe(true);
    expect(requestGpuTimestampSample(profiler)).toBe(false);
  });

  it("resolves one explicitly sampled frame and releases its pending slot", async () => {
    const { device, buffers, mapAsync } = createSupportedFixture();
    const profiler = createGpuTimestampProfiler(device);
    const encoder = {
      resolveQuerySet: vi.fn(),
      copyBufferToBuffer: vi.fn(),
    } as unknown as GPUCommandEncoder;

    requestGpuTimestampSample(profiler);
    const sampled = beginGpuTimestampSample(profiler);
    expect(encodeGpuTimestampResolve(profiler, encoder, sampled)).toBe(true);
    requestGpuTimestampRead(profiler, sampled);
    await Promise.resolve();

    expect(mapAsync).toHaveBeenCalledTimes(1);
    expect(encoder.resolveQuerySet).toHaveBeenCalledTimes(1);
    expect(encoder.copyBufferToBuffer).toHaveBeenCalledTimes(1);
    expect(profiler.gpuTimeMs).toBe(3.5);
    expect(profiler.samplePending).toBe(false);
    expect(buffers[1]?.unmap).toHaveBeenCalledTimes(1);
  });

  it("returns to an unsampled state after a failed map", async () => {
    const mapAsync = vi.fn(() => Promise.reject(new Error("map failed")));
    const { device } = createSupportedFixture(mapAsync);
    const profiler = createGpuTimestampProfiler(device);

    requestGpuTimestampSample(profiler);
    requestGpuTimestampRead(profiler, beginGpuTimestampSample(profiler));
    await Promise.resolve();
    await Promise.resolve();

    expect(profiler.gpuTimeMs).toBeNull();
    expect(profiler.samplePending).toBe(false);
    expect(requestGpuTimestampSample(profiler)).toBe(true);
  });

  it("ignores late completion after disposal and destroys resources once", async () => {
    let resolveMap: (() => void) | undefined;
    const mapAsync = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveMap = resolve;
        }),
    );
    const { device, querySet, buffers } = createSupportedFixture(mapAsync);
    const profiler = createGpuTimestampProfiler(device);

    requestGpuTimestampSample(profiler);
    requestGpuTimestampRead(profiler, beginGpuTimestampSample(profiler));
    destroyGpuTimestampProfiler(profiler);
    destroyGpuTimestampProfiler(profiler);
    resolveMap?.();
    await Promise.resolve();

    expect(requestGpuTimestampSample(profiler)).toBe(false);
    expect(profiler.gpuTimeMs).toBeNull();
    expect(querySet.destroy).toHaveBeenCalledTimes(1);
    expect(buffers).toHaveLength(2);
    for (const buffer of buffers) expect(buffer.destroy).toHaveBeenCalledTimes(1);
  });

  it("destroys partial resources when readback allocation fails", () => {
    installGpuConstants();
    const querySet = { destroy: vi.fn() };
    const buffers: Array<{ readonly destroy: ReturnType<typeof vi.fn> }> = [];
    const device = {
      features: new Set<GPUFeatureName>(["timestamp-query"]),
      createQuerySet: vi.fn(() => querySet),
      createBuffer: vi.fn(() => {
        if (buffers.length === 1) throw new Error("readback allocation failed");
        const buffer = { destroy: vi.fn() };
        buffers.push(buffer);
        return buffer;
      }),
    } as unknown as GPUDevice;

    expect(() => createGpuTimestampProfiler(device)).toThrow("readback allocation failed");
    expect(querySet.destroy).toHaveBeenCalledTimes(1);
    expect(buffers).toHaveLength(1);
    expect(buffers[0]?.destroy).toHaveBeenCalledTimes(1);
  });
});
