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
  /** Preferred adapter power class. */
  readonly powerPreference?: GPUPowerPreference;
  /** Canvas alpha-compositing mode. */
  readonly alphaMode?: GPUCanvasAlphaMode;
  /** Linear clear color for the main pass. */
  readonly clearColor?: GPUColor;
  /** Features that must be available on the selected device. */
  readonly requiredFeatures?: readonly GPUFeatureName[];
}

/** Extracted, capacity-backed renderer input for one frame. */
export interface RenderFrame {
  /** Number of entries to read from the instance arrays. */
  instanceCount: number;
  /** Number of camera records to read from `cameraData`. */
  cameraCount: number;
  /** Geometry handles ordered to match `instanceData`. */
  geometries: Uint32Array<ArrayBuffer>;
  /** Pipeline handles ordered to match `instanceData`. */
  pipelines: Uint32Array<ArrayBuffer>;
  /** Material handles ordered to match `instanceData`. */
  materials: Uint32Array<ArrayBuffer>;
  /** Packed model-matrix/color records. */
  instanceData: Float32Array<ArrayBuffer>;
  /** Packed view/projection camera records. */
  cameraData: Float32Array<ArrayBuffer>;
}

/** Measurements collected from the most recently encoded frame. */
export interface RendererStats {
  /** Total bytes held by renderer-owned GPU buffers. */
  readonly gpuBufferBytes: number;
  /** Indexed draw calls submitted for the frame. */
  readonly drawCalls: number;
  /** Visible instances submitted to WebGPU. */
  readonly submittedInstances: number;
  /** CPU duration of buffer writes in milliseconds. */
  readonly bufferUploadCpuTimeMs: number;
  /** CPU duration of extraction-input preparation and encoding in milliseconds. */
  readonly framePreparationCpuTimeMs: number;
  /** Timestamp-query duration, or null when unsupported/unavailable. */
  readonly gpuTimeMs: number | null;
  /** WebGPU objects necessarily created for the most recently encoded frame. */
  readonly browserObjectsPerFrame: number;
}

export interface MeshRenderer {
  /** Resolves when the owned GPU device is lost. */
  readonly lost: Promise<GPUDeviceLostInfo>;
  /** Uploads and renders one extracted frame. */
  execute(frame: RenderFrame): void;
  /** Reconfigures the surface and depth attachment if physical size changed. */
  resize(size: SurfaceSize): void;
  /** Returns the latest renderer measurements. */
  stats(): RendererStats;
  /** Releases every renderer-owned GPU resource; safe to call repeatedly. */
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
  readonly clearColor: GPUColor;
  colorAttachment: GPURenderPassColorAttachment | undefined;
  readonly depthAttachment: GPURenderPassDepthStencilAttachment;
  passDescriptor: GPURenderPassDescriptor | undefined;
  readonly submissions: GPUCommandBuffer[];
  drawCalls: number;
  submittedInstances: number;
  bufferUploadCpuTimeMs: number;
  framePreparationCpuTimeMs: number;
  browserObjectsPerFrame: number;
  disposed: boolean;
}

interface RendererFrameContext {
  readonly state: RendererState;
  frame: RenderFrame | undefined;
  preparationStart: number;
}

/**
 * Creates a worker-owned WebGPU mesh renderer.
 *
 * @throws {RangeError} When `instanceCapacity` exceeds device storage limits.
 */
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
  const pipelineCache = createPipelineCache();
  let surface: SurfaceState | undefined;
  let meshes: MeshRegistry | undefined;
  let profiler: GpuTimestampProfiler | undefined;
  let cameraBuffer: GPUBuffer | undefined;
  let instanceBuffer: GPUBuffer | undefined;
  try {
    const instanceBytes = Math.max(INSTANCE_BYTES, instanceCapacity * INSTANCE_BYTES);
    if (
      instanceBytes > device.limits.maxStorageBufferBindingSize ||
      instanceBytes > device.limits.maxBufferSize
    ) {
      throw new RangeError(
        `Configured render capacity requires ${instanceBytes} bytes, exceeding this device's storage-buffer limit.`,
      );
    }

    surface = createSurface(device, canvas, size, options.alphaMode ?? "opaque");
    const pipeline = await getMeshPipeline(device, pipelineCache, surface.format);
    meshes = createMeshRegistry(device, BUILTIN_MESHES);
    profiler = createGpuTimestampProfiler(device);
    cameraBuffer = device.createBuffer({
      label: "Lume camera uniform",
      size: CAMERA_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    instanceBuffer = device.createBuffer({
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

    const depthAttachment: GPURenderPassDepthStencilAttachment = {
      view: surface.depthView,
      depthClearValue: 1,
      depthLoadOp: "clear",
      depthStoreOp: "discard",
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
      clearColor: options.clearColor ?? { r: 0.018, g: 0.024, b: 0.04, a: 1 },
      colorAttachment: undefined,
      depthAttachment,
      passDescriptor: undefined,
      submissions: new Array<GPUCommandBuffer>(1),
      drawCalls: 0,
      submittedInstances: 0,
      bufferUploadCpuTimeMs: 0,
      framePreparationCpuTimeMs: 0,
      browserObjectsPerFrame: 0,
      disposed: false,
    };
    const frameGraph = createRendererFrameGraph();
    const frameContext: RendererFrameContext = {
      state,
      frame: undefined,
      preparationStart: 0,
    };

    const renderer: MeshRenderer = {
      lost: device.lost,
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
        browserObjectsPerFrame: state.browserObjectsPerFrame,
      }),
      dispose: () => dispose(state),
    };
    return renderer;
  } catch (error) {
    instanceBuffer?.destroy();
    cameraBuffer?.destroy();
    if (profiler !== undefined) destroyGpuTimestampProfiler(profiler);
    meshes?.dispose();
    pipelineCache.clear();
    if (surface !== undefined) destroySurface(surface);
    device.destroy();
    throw error;
  }
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
  if (frame === undefined) throw new Error("Renderer frame context is not initialized.");
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
  if (frame === undefined) throw new Error("Renderer frame context is not initialized.");
  const instanceCount = frame.instanceCount;
  const colorView = state.surface.context.getCurrentTexture().createView();
  const colorAttachment = state.colorAttachment ?? {
    view: colorView,
    clearValue: state.clearColor,
    loadOp: "clear",
    storeOp: "store",
  };
  state.colorAttachment = colorAttachment;
  colorAttachment.view = colorView;
  state.depthAttachment.view = state.surface.depthView;
  const passDescriptor = state.passDescriptor ?? {
    label: "Lume main render pass",
    colorAttachments: [colorAttachment],
    depthStencilAttachment: state.depthAttachment,
    ...(state.profiler.timestampWrites === undefined
      ? {}
      : { timestampWrites: state.profiler.timestampWrites }),
  };
  state.passDescriptor = passDescriptor;
  const encoder = state.device.createCommandEncoder({ label: "Lume frame commands" });
  const pass = encoder.beginRenderPass(passDescriptor);
  // WebGPU mandates these frame-scoped objects: surface texture/view, command
  // encoder, render pass encoder, and command buffer. Engine-owned arrays and
  // descriptors remain reusable and are deliberately not included.
  state.browserObjectsPerFrame = 5;
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
  state.device.destroy();
}
