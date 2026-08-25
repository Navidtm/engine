import { describe, expect, it, vi } from "vitest";

import { createMeshRenderer, type RenderFrame } from "./mesh-renderer.js";
import type * as SurfaceModule from "./webgpu/surface.js";

const mocks = vi.hoisted(() => ({
  destroySurface: vi.fn(),
  getMeshPipeline: vi.fn(),
  createVisibilityPipelines: vi.fn(),
  requestAdapter: vi.fn(),
  requestDevice: vi.fn(),
}));

vi.mock("./pipeline/mesh.js", () => ({ getMeshPipeline: mocks.getMeshPipeline }));
vi.mock("./pipeline/visibility.js", () => ({
  createVisibilityPipelines: mocks.createVisibilityPipelines,
}));
vi.mock("./webgpu/adapter.js", () => ({ requestAdapter: mocks.requestAdapter }));
vi.mock("./webgpu/device.js", () => ({ requestDevice: mocks.requestDevice }));
vi.mock("./webgpu/surface.js", async (loadOriginal) => {
  const original = await loadOriginal<typeof SurfaceModule>();
  return {
    ...original,
    createSurface: vi.fn(() => ({
      canvas: {},
      context: {},
      format: "rgba8unorm",
      depthTexture: {},
      depthView: {},
      width: 1,
      height: 1,
    })),
    destroySurface: mocks.destroySurface,
  };
});

describe("mesh renderer initialization ownership", () => {
  it("rejects oversized derived buffers before creating GPU resources", async () => {
    const device = {
      features: new Set<GPUFeatureName>(),
      limits: {
        maxStorageBufferBindingSize: 100,
        maxBufferSize: 100,
      },
      createBuffer: vi.fn(),
      destroy: vi.fn(),
    } as unknown as GPUDevice;
    mocks.requestAdapter.mockResolvedValueOnce({ features: new Set() });
    mocks.requestDevice.mockResolvedValueOnce(device);

    await expect(
      createMeshRenderer({} as OffscreenCanvas, { width: 1, height: 1, devicePixelRatio: 1 }, 2),
    ).rejects.toThrow("instance buffer");

    expect(device.createBuffer).not.toHaveBeenCalled();
    expect(device.destroy).toHaveBeenCalledTimes(1);
  });

  it("destroys the surface and device when pipeline creation fails", async () => {
    const device = {
      features: new Set<GPUFeatureName>(),
      limits: {
        maxStorageBufferBindingSize: 1_000_000,
        maxBufferSize: 1_000_000,
      },
      destroy: vi.fn(),
    } as unknown as GPUDevice;
    mocks.requestAdapter.mockResolvedValueOnce({ features: new Set() });
    mocks.requestDevice.mockResolvedValueOnce(device);
    mocks.getMeshPipeline.mockRejectedValueOnce(new Error("pipeline failed"));

    await expect(
      createMeshRenderer({} as OffscreenCanvas, { width: 1, height: 1, devicePixelRatio: 1 }, 1),
    ).rejects.toThrow("pipeline failed");

    expect(mocks.destroySurface).toHaveBeenCalledTimes(1);
    expect(device.destroy).toHaveBeenCalledTimes(1);
  });

  it("disposes every persistent scene, visibility, indirect, and readback buffer", async () => {
    vi.stubGlobal("GPUBufferUsage", {
      MAP_READ: 1,
      COPY_SRC: 2,
      COPY_DST: 4,
      UNIFORM: 8,
      STORAGE: 16,
      INDIRECT: 32,
    });
    const buffers: Array<{ size: number; destroy: ReturnType<typeof vi.fn> }> = [];
    const device = {
      features: new Set<GPUFeatureName>(),
      limits: {
        maxStorageBufferBindingSize: 1_000_000,
        maxBufferSize: 1_000_000,
      },
      queue: { writeBuffer: vi.fn() },
      createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
        const buffer = { size: Number(descriptor.size), destroy: vi.fn() };
        buffers.push(buffer);
        return buffer;
      }),
      createBindGroup: vi.fn(() => ({})),
      destroy: vi.fn(),
      lost: new Promise<GPUDeviceLostInfo>(() => undefined),
    } as unknown as GPUDevice;
    const pipeline = { getBindGroupLayout: vi.fn(() => ({})) } as unknown as GPURenderPipeline;
    mocks.requestAdapter.mockResolvedValueOnce({ features: new Set() });
    mocks.requestDevice.mockResolvedValueOnce(device);
    mocks.getMeshPipeline.mockResolvedValueOnce(pipeline);
    mocks.createVisibilityPipelines.mockResolvedValueOnce({
      bindGroupLayout: {},
      reset: {},
      cull: {},
    });

    const renderer = await createMeshRenderer(
      {} as OffscreenCanvas,
      { width: 1, height: 1, devicePixelRatio: 1 },
      4,
    );
    expect(() => renderer.execute({ instanceCount: 5, candidateCount: 0 } as RenderFrame)).toThrow(
      "instanceCount 5",
    );
    expect(() => renderer.execute({ instanceCount: 0, candidateCount: 5 } as RenderFrame)).toThrow(
      "candidateCount 5",
    );
    renderer.dispose();
    renderer.dispose();

    expect(buffers).toHaveLength(12);
    for (const buffer of buffers) expect(buffer.destroy).toHaveBeenCalledTimes(1);
    expect(device.destroy).toHaveBeenCalledTimes(1);
  });
});
