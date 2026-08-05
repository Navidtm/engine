import { MESH_SHADER } from "../shaders/mesh.wgsl.js";
import type { PipelineCache } from "./cache.js";

/** Gets the cached built-in indexed mesh pipeline for the target surface format. */
export function getMeshPipeline(
  device: GPUDevice,
  cache: PipelineCache,
  format: GPUTextureFormat,
): Promise<GPURenderPipeline> {
  return cache.getOrCreate(`mesh:${format}:depth24plus:v1`, async () => {
    const shader = device.createShaderModule({ label: "Lume mesh shader", code: MESH_SHADER });
    return device.createRenderPipelineAsync({
      label: "Lume indexed mesh pipeline",
      layout: "auto",
      vertex: {
        module: shader,
        entryPoint: "vertex_main",
        buffers: [
          {
            arrayStride: 24,
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
          },
        ],
      },
      fragment: {
        module: shader,
        entryPoint: "fragment_main",
        targets: [{ format }],
      },
      primitive: { topology: "triangle-list", frontFace: "ccw", cullMode: "back" },
      depthStencil: {
        format: "depth24plus",
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });
  });
}
