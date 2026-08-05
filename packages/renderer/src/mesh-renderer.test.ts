import { describe, expect, it, vi } from "vitest";

import { createMeshRenderer } from "./mesh-renderer.js";

const mocks = vi.hoisted(() => ({
  destroySurface: vi.fn(),
  getMeshPipeline: vi.fn(),
  requestAdapter: vi.fn(),
  requestDevice: vi.fn(),
}));

vi.mock("./pipeline/mesh.js", () => ({ getMeshPipeline: mocks.getMeshPipeline }));
vi.mock("./webgpu/adapter.js", () => ({ requestAdapter: mocks.requestAdapter }));
vi.mock("./webgpu/device.js", () => ({ requestDevice: mocks.requestDevice }));
vi.mock("./webgpu/surface.js", async (loadOriginal) => {
  const original = await loadOriginal<typeof import("./webgpu/surface.js")>();
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
});
