import {
  addFramePass,
  addFrameResource,
  type CompiledFrameGraph,
  compileFrameGraph,
  createFrameGraph,
  executeFrameGraph,
} from "./framegraph/graph.js";
import { defineFramePass } from "./framegraph/pass.js";
import { BUILTIN_MESHES } from "./geometry/mesh-data.js";
import { createPipelineCache, type PipelineCache } from "./pipeline/cache.js";
import { getMeshPipeline } from "./pipeline/mesh.js";
import { requestAdapter } from "./webgpu/adapter.js";
import { requestDevice } from "./webgpu/device.js";
import { createMeshRegistry, type MeshRegistry } from "./webgpu/mesh-registry.js";
import {
  createSurface,
  destroySurface,
  resizeSurface,
  type SurfaceSize,
  type SurfaceState,
} from "./webgpu/surface.js";
import {
  createGpuTimestampProfiler,
  destroyGpuTimestampProfiler,
  encodeGpuTimestampResolve,
  type GpuTimestampProfiler,
  requestGpuTimestampRead,
} from "./webgpu/timestamp-profiler.js";

const INSTANCE_FLOATS = 20;
const INSTANCE_BYTES = INSTANCE_FLOATS * Float32Array.BYTES_PER_ELEMENT;
const CAMERA_FLOATS = 32;
const CAMERA_BYTES = CAMERA_FLOATS * Float32Array.BYTES_PER_ELEMENT;
const BASIC_PIPELINE_ID = 1;

const DEFAULT_CAMERA = new Float32Array(CAMERA_FLOATS);
DEFAULT_CAMERA[0] = 1;
DEFAULT_CAMERA[5] = 1;
DEFAULT_CAMERA[10] = 1;
DEFAULT_CAMERA[15] = 1;
DEFAULT_CAMERA[16] = 1;
DEFAULT_CAMERA[21] = 1;
DEFAULT_CAMERA[26] = 1;
DEFAULT_CAMERA[31] = 1;

export interface RendererOptions {
  readonly powerPreference?: GPUPowerPreference;
  readonly alphaMode?: GPUCanvasAlphaMode;
  readonly clearColor?: GPUColor;
  readonly requiredFeatures?: readonly GPUFeatureName[];
}

export interface RenderFrame {
  instanceCount: number;
  cameraCount: number;
  geometries: Uint32Array<ArrayBuffer>;
  pipelines: Uint32Array<ArrayBuffer>;
  materials: Uint32Array<ArrayBuffer>;
  instanceData: Float32Array<ArrayBuffer>;
  cameraData: Float32Array<ArrayBuffer>;
}

export interface RendererStats {
  readonly gpuBufferBytes: number;
  readonly drawCalls: number;
  readonly submittedInstances: number;
  readonly bufferUploadCpuTimeMs: number;
  readonly framePreparationCpuTimeMs: number;
  readonly gpuTimeMs: number | null;
}

export interface MeshRenderer {
  readonly device: GPUDevice;
  execute(frame: RenderFrame): void;
  resize(size: SurfaceSize): void;
  stats(): RendererStats;
  dispose(): void;
}

interface RendererState {
  readonly device: GPUDevice;
  readonly surface: SurfaceState;
  readonly pipeline: GPURenderPipeline;
  readonly pipelineCache: PipelineCache;
  readonly meshes: MeshRegistry;
  readonly cameraBuffer: GPUBuffer;
  readonly instanceBuffer: GPUBuffer;
  readonly bindGroup: GPUBindGroup;
  readonly profiler: GpuTimestampProfiler;
  readonly colorAttachment: GPURenderPassColorAttachment;
  readonly depthAttachment: GPURenderPassDepthStencilAttachment;
  readonly passDescriptor: GPURenderPassDescriptor;
  readonly submissions: GPUCommandBuffer[];
  drawCalls: number;
  submittedInstances: number;
  bufferUploadCpuTimeMs: number;
  framePreparationCpuTimeMs: number;
  disposed: boolean;
}

interface RendererFrameContext {
  readonly state: RendererState;
  frame: RenderFrame;
  preparationStart: number;
}

export async function createMeshRenderer(
  canvas: OffscreenCanvas,
  size: SurfaceSize,
  instanceCapacity: number,
  options: RendererOptions = {},
): Promise<MeshRenderer> {
  const adapter = await requestAdapter(
    options.powerPreference === undefined ? {} : { powerPreference: options.powerPreference },
  );
  const requiredFeatures = [...(options.requiredFeatures ?? [])];
  if (adapter.features.has("timestamp-query") && !requiredFeatures.includes("timestamp-query")) {
    requiredFeatures.push("timestamp-query");
  }
  const device = await requestDevice(adapter, { requiredFeatures });
  const instanceBytes = Math.max(INSTANCE_BYTES, instanceCapacity * INSTANCE_BYTES);
  if (
    instanceBytes > device.limits.maxStorageBufferBindingSize ||
    instanceBytes > device.limits.maxBufferSize
  ) {
    throw new RangeError(
      `Configured render capacity requires ${instanceBytes} bytes, exceeding this device's storage-buffer limit.`,
    );
  }

  const surface = createSurface(device, canvas, size, options.alphaMode ?? "opaque");
  const pipelineCache = createPipelineCache();
  const pipeline = await getMeshPipeline(device, pipelineCache, surface.format);
  const meshes = createMeshRegistry(device, BUILTIN_MESHES);
  const profiler = createGpuTimestampProfiler(device);
  const cameraBuffer = device.createBuffer({
    label: "Lume camera uniform",
    size: CAMERA_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const instanceBuffer = device.createBuffer({
    label: "Lume render instances",
    size: instanceBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const bindGroup = device.createBindGroup({
    label: "Lume frame bind group",
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: cameraBuffer } },
      { binding: 1, resource: { buffer: instanceBuffer } },
    ],
  });
  device.queue.writeBuffer(cameraBuffer, 0, DEFAULT_CAMERA);

  const colorAttachment: GPURenderPassColorAttachment = {
    view: undefined as unknown as GPUTextureView,
    clearValue: options.clearColor ?? { r: 0.018, g: 0.024, b: 0.04, a: 1 },
    loadOp: "clear",
    storeOp: "store",
  };
  const depthAttachment: GPURenderPassDepthStencilAttachment = {
    view: surface.depthView,
    depthClearValue: 1,
    depthLoadOp: "clear",
    depthStoreOp: "discard",
  };
  const passDescriptor: GPURenderPassDescriptor = {
    label: "Lume main render pass",
    colorAttachments: [colorAttachment],
    depthStencilAttachment: depthAttachment,
    ...(profiler.timestampWrites === undefined
      ? {}
      : { timestampWrites: profiler.timestampWrites }),
  };
  const state: RendererState = {
    device,
    surface,
    pipeline,
    pipelineCache,
    meshes,
    cameraBuffer,
    instanceBuffer,
    bindGroup,
    profiler,
    colorAttachment,
    depthAttachment,
    passDescriptor,
    submissions: [undefined as unknown as GPUCommandBuffer],
    drawCalls: 0,
    submittedInstances: 0,
    bufferUploadCpuTimeMs: 0,
    framePreparationCpuTimeMs: 0,
    disposed: false,
  };
  const frameGraph = createRendererFrameGraph();
  const frameContext: RendererFrameContext = {
    state,
    frame: undefined as unknown as RenderFrame,
    preparationStart: 0,
  };

  const renderer: MeshRenderer = {
    device,
    execute(frame) {
      if (state.disposed) return;
      frameContext.frame = frame;
      frameContext.preparationStart = performance.now();
      executeFrameGraph(frameGraph, frameContext);
    },
    resize: (nextSize) => resize(state, nextSize),
    stats: () => ({
      gpuBufferBytes:
        state.meshes.gpuBytes +
        state.cameraBuffer.size +
        state.instanceBuffer.size +
        state.profiler.gpuBytes,
      drawCalls: state.drawCalls,
      submittedInstances: state.submittedInstances,
      bufferUploadCpuTimeMs: state.bufferUploadCpuTimeMs,
      framePreparationCpuTimeMs: state.framePreparationCpuTimeMs,
      gpuTimeMs: state.profiler.gpuTimeMs,
    }),
    dispose: () => dispose(state),
  };
  return Object.freeze(renderer);
}

function createRendererFrameGraph(): CompiledFrameGraph<RendererFrameContext> {
  const graph = createFrameGraph<RendererFrameContext>();
  const extractedFrame = addFrameResource(graph, "visible-render-items");
  const uploadedFrame = addFrameResource(graph, "gpu-frame-data");
  const colorTarget = addFrameResource(graph, "surface-color");
  const depthTarget = addFrameResource(graph, "surface-depth");
  addFramePass(
    graph,
    defineFramePass({
      name: "upload",
      reads: [extractedFrame],
      writes: [uploadedFrame],
      execute: uploadFrame,
    }),
  );
  addFramePass(
    graph,
    defineFramePass({
      name: "main-render",
      reads: [uploadedFrame],
      writes: [colorTarget, depthTarget],
      execute: encodeMainPass,
    }),
  );
  return compileFrameGraph(graph);
}

function uploadFrame(context: RendererFrameContext): void {
  const { state, frame } = context;
  const uploadStart = performance.now();
  const instanceCount = frame.instanceCount;
  if (instanceCount > 0) {
    state.device.queue.writeBuffer(
      state.instanceBuffer,
      0,
      frame.instanceData.buffer,
      frame.instanceData.byteOffset,
      instanceCount * INSTANCE_BYTES,
    );
  }
  if (frame.cameraCount > 0) {
    state.device.queue.writeBuffer(
      state.cameraBuffer,
      0,
      frame.cameraData.buffer,
      frame.cameraData.byteOffset,
      CAMERA_BYTES,
    );
  }
  state.bufferUploadCpuTimeMs = performance.now() - uploadStart;
}

function encodeMainPass(context: RendererFrameContext): void {
  const { state, frame } = context;
  const instanceCount = frame.instanceCount;
  state.colorAttachment.view = state.surface.context.getCurrentTexture().createView();
  state.depthAttachment.view = state.surface.depthView;
  const encoder = state.device.createCommandEncoder({ label: "Lume frame commands" });
  const pass = encoder.beginRenderPass(state.passDescriptor);
  pass.setPipeline(state.pipeline);
  pass.setBindGroup(0, state.bindGroup);

  let instance = 0;
  let drawCalls = 0;
  while (instance < instanceCount) {
    const geometry = frame.geometries[instance] ?? 0;
    const pipeline = frame.pipelines[instance] ?? 0;
    const material = frame.materials[instance] ?? 0;
    const mesh = state.meshes.get(geometry);
    let runEnd = instance + 1;
    while (
      runEnd < instanceCount &&
      frame.pipelines[runEnd] === pipeline &&
      frame.materials[runEnd] === material &&
      frame.geometries[runEnd] === geometry
    ) {
      runEnd += 1;
    }
    if (pipeline === BASIC_PIPELINE_ID && mesh !== undefined) {
      pass.setVertexBuffer(0, mesh.vertexBuffer);
      pass.setIndexBuffer(mesh.indexBuffer, "uint32");
      pass.drawIndexed(mesh.indexCount, runEnd - instance, 0, 0, instance);
      drawCalls += 1;
    }
    instance = runEnd;
  }
  pass.end();
  const timestampReadback = encodeGpuTimestampResolve(state.profiler, encoder);
  state.submissions[0] = encoder.finish();
  state.device.queue.submit(state.submissions);
  requestGpuTimestampRead(state.profiler, timestampReadback);
  state.drawCalls = drawCalls;
  state.submittedInstances = instanceCount;
  state.framePreparationCpuTimeMs = performance.now() - context.preparationStart;
}

function resize(state: RendererState, size: SurfaceSize): void {
  if (!state.disposed) resizeSurface(state.device, state.surface, size);
}

function dispose(state: RendererState): void {
  if (state.disposed) return;
  state.disposed = true;
  state.meshes.dispose();
  destroyGpuTimestampProfiler(state.profiler);
  state.cameraBuffer.destroy();
  state.instanceBuffer.destroy();
  state.pipelineCache.clear();
  destroySurface(state.surface);
}
