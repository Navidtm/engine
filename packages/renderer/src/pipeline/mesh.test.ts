import { describe, expect, it, vi } from "vitest";

import { createPipelineCache } from "./cache.js";
import { createMeshPipelineLayout, getMeshPipeline } from "./mesh.js";

describe("mesh pipeline layout", () => {
  it("uses one explicit frame-resource layout for pipeline and bind groups", async () => {
    vi.stubGlobal("GPUShaderStage", { VERTEX: 1 });
    const bindGroupLayout = {} as GPUBindGroupLayout;
    const pipelineLayout = {} as GPUPipelineLayout;
    const pipeline = {} as GPURenderPipeline;
    const device = {
      createBindGroupLayout: vi.fn(() => bindGroupLayout),
      createPipelineLayout: vi.fn(() => pipelineLayout),
      createShaderModule: vi.fn(() => ({})),
      createRenderPipelineAsync: vi.fn(() => Promise.resolve(pipeline)),
    } as unknown as GPUDevice;

    const layout = createMeshPipelineLayout(device);
    const result = await getMeshPipeline(
      device,
      createPipelineCache(),
      "rgba8unorm",
      layout.pipelineLayout,
    );

    expect(layout.bindGroupLayout).toBe(bindGroupLayout);
    expect(device.createBindGroupLayout).toHaveBeenCalledWith(
      expect.objectContaining({
        entries: [
          expect.objectContaining({ binding: 0, buffer: { type: "uniform" } }),
          expect.objectContaining({ binding: 1, buffer: { type: "read-only-storage" } }),
          expect.objectContaining({ binding: 2, buffer: { type: "read-only-storage" } }),
        ],
      }),
    );
    expect(device.createRenderPipelineAsync).toHaveBeenCalledWith(
      expect.objectContaining({ layout: pipelineLayout }),
    );
    expect(result).toBe(pipeline);
  });
});
