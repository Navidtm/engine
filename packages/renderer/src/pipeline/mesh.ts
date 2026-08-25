import { MESH_SHADER } from "../shaders/mesh.wgsl.js";
import type { PipelineCache } from "./cache.js";

export interface MeshPipelineLayout {
  readonly bindGroupLayout: GPUBindGroupLayout;
  readonly pipelineLayout: GPUPipelineLayout;
}

/** Creates the frame-resource layout shared by every mesh material pipeline. */
export function createMeshPipelineLayout(device: GPUDevice): MeshPipelineLayout {
  const bindGroupLayout = device.createBindGroupLayout({
    label: "Lume mesh frame bind group layout",
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    ],
  });
  const pipelineLayout = device.createPipelineLayout({
    label: "Lume mesh pipeline layout",
    bindGroupLayouts: [bindGroupLayout],
  });
  return { bindGroupLayout, pipelineLayout };
}

/** Gets the cached built-in indexed mesh pipeline for the target surface format. */
export function getMeshPipeline(
  device: GPUDevice,
  cache: PipelineCache,
  format: GPUTextureFormat,
  layout: GPUPipelineLayout,
): Promise<GPURenderPipeline> {
  return cache.getOrCreate(`mesh:${format}:depth24plus:v3`, async () => {
    const shader = device.createShaderModule({ label: "Lume mesh shader", code: MESH_SHADER });
    return device.createRenderPipelineAsync({
      label: "Lume indexed mesh pipeline",
      layout,
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
