import { VISIBILITY_SHADER } from "../shaders/visibility.wgsl.js";

export interface VisibilityPipelines {
  readonly bindGroupLayout: GPUBindGroupLayout;
  readonly reset: GPUComputePipeline;
  readonly cull: GPUComputePipeline;
}

/** Creates the persistent compute visibility pipelines and their explicit layout. */
export async function createVisibilityPipelines(device: GPUDevice): Promise<VisibilityPipelines> {
  const bindGroupLayout = device.createBindGroupLayout({
    label: "Lume visibility bind group layout",
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
    ],
  });
  const layout = device.createPipelineLayout({
    label: "Lume visibility pipeline layout",
    bindGroupLayouts: [bindGroupLayout],
  });
  const module = device.createShaderModule({
    label: "Lume compute visibility shader",
    code: VISIBILITY_SHADER,
  });
  const [reset, cull] = await Promise.all([
    device.createComputePipelineAsync({
      label: "Lume indirect reset pipeline",
      layout,
      compute: { module, entryPoint: "reset_commands" },
    }),
    device.createComputePipelineAsync({
      label: "Lume compute visibility pipeline",
      layout,
      compute: { module, entryPoint: "cull_candidates" },
    }),
  ]);
  return { bindGroupLayout, reset, cull };
}
