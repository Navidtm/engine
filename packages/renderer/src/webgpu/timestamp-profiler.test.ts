import { afterEach, describe, expect, it, vi } from "vitest";

import { createGpuTimestampProfiler, destroyGpuTimestampProfiler } from "./timestamp-profiler.js";

afterEach(() => vi.unstubAllGlobals());

describe("GPU timestamp profiler ownership", () => {
  it("returns an unsupported profiler without allocating resources", () => {
    const device = {
      features: new Set<GPUFeatureName>(),
      createBuffer: vi.fn(),
      createQuerySet: vi.fn(),
    } as unknown as GPUDevice;
    const profiler = createGpuTimestampProfiler(device);
    expect(profiler.timestampWrites).toBeUndefined();
    expect(profiler.gpuTimeMs).toBeNull();
    expect(device.createBuffer).not.toHaveBeenCalled();
  });

  it("destroys every GPU resource it owns exactly once", () => {
    vi.stubGlobal("GPUBufferUsage", {
      QUERY_RESOLVE: 1,
      COPY_SRC: 2,
      MAP_READ: 4,
      COPY_DST: 8,
    });
    const querySet = { destroy: vi.fn() };
    const buffers: Array<{ readonly size: number; readonly destroy: ReturnType<typeof vi.fn> }> =
      [];
    const device = {
      features: new Set<GPUFeatureName>(["timestamp-query"]),
      createQuerySet: vi.fn(() => querySet),
      createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
        const buffer = { size: Number(descriptor.size), destroy: vi.fn() };
        buffers.push(buffer);
        return buffer;
      }),
    } as unknown as GPUDevice;

    const profiler = createGpuTimestampProfiler(device);
    expect(profiler.gpuBytes).toBe(64);
    destroyGpuTimestampProfiler(profiler);
    destroyGpuTimestampProfiler(profiler);

    expect(querySet.destroy).toHaveBeenCalledTimes(1);
    expect(buffers).toHaveLength(4);
    for (const buffer of buffers) expect(buffer.destroy).toHaveBeenCalledTimes(1);
  });

  it("destroys partial resources when readback allocation fails", () => {
    vi.stubGlobal("GPUBufferUsage", {
      QUERY_RESOLVE: 1,
      COPY_SRC: 2,
      MAP_READ: 4,
      COPY_DST: 8,
    });
    const querySet = { destroy: vi.fn() };
    const buffers: Array<{ readonly destroy: ReturnType<typeof vi.fn> }> = [];
    const device = {
      features: new Set<GPUFeatureName>(["timestamp-query"]),
      createQuerySet: vi.fn(() => querySet),
      createBuffer: vi.fn(() => {
        if (buffers.length === 2) throw new Error("readback allocation failed");
        const buffer = { destroy: vi.fn() };
        buffers.push(buffer);
        return buffer;
      }),
    } as unknown as GPUDevice;

    expect(() => createGpuTimestampProfiler(device)).toThrow("readback allocation failed");
    expect(querySet.destroy).toHaveBeenCalledTimes(1);
    expect(buffers).toHaveLength(2);
    for (const buffer of buffers) expect(buffer.destroy).toHaveBeenCalledTimes(1);
  });
});
