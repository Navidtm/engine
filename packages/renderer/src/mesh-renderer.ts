import {
  addFramePass,
  addFrameResource,
  type CompiledFrameGraph,
  compileFrameGraph,
  createFrameGraph,
  executeFrameGraph,
} from "./framegraph/graph.js";
import { defineFramePass } from "./framegraph/pass.js";
import { writeFrustumPlanes } from "./frustum-planes.js";
import { BUILTIN_MESHES } from "./geometry/mesh-data.js";
import { createPipelineCache, type PipelineCache } from "./pipeline/cache.js";
import { createMeshPipelineLayout, getMeshPipeline } from "./pipeline/mesh.js";
import { createVisibilityPipelines, type VisibilityPipelines } from "./pipeline/visibility.js";
import { requestAdapter } from "./webgpu/adapter.js";
import { requestDevice } from "./webgpu/device.js";
import { createMaterialRegistry, type MaterialRegistry } from "./webgpu/material-registry.js";
import { createMeshRegistry, type GpuMesh, type MeshRegistry } from "./webgpu/mesh-registry.js";
import {
  createSurface,
  destroySurface,
  resizeSurface,
  type SurfaceSize,
  type SurfaceState,
} from "./webgpu/surface.js";
import {
  beginGpuTimestampSample,
  createGpuTimestampProfiler,
  destroyGpuTimestampProfiler,
  encodeGpuTimestampResolve,
  type GpuTimestampProfiler,
  requestGpuTimestampRead,
  requestGpuTimestampSample,
  unmapBufferSafely,
} from "./webgpu/timestamp-profiler.js";

const INSTANCE_FLOATS = 20;
const INSTANCE_BYTES = INSTANCE_FLOATS * Float32Array.BYTES_PER_ELEMENT;
const VISIBLE_SLOT_BYTES = Uint32Array.BYTES_PER_ELEMENT;
const SLOT_RECORD_BYTES = 4 * Uint32Array.BYTES_PER_ELEMENT;
const INDIRECT_WORDS = 5;
const INDIRECT_BYTES = INDIRECT_WORDS * Uint32Array.BYTES_PER_ELEMENT;
const VISIBILITY_PARAMETER_WORDS = 28;
const VISIBILITY_PARAMETER_BYTES = VISIBILITY_PARAMETER_WORDS * Uint32Array.BYTES_PER_ELEMENT;
const FRUSTUM_PLANE_OFFSET = 4;
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
  /** Visibility backend. `auto` retains the measured CPU reference policy. */
  readonly visibilityMode?: "auto" | "cpu" | "gpu";
}

/** Extracted, capacity-backed renderer input for one frame. */
export interface RenderFrame {
  /** Number of entries to read from the instance arrays. */
  instanceCount: number;
  /** Number of changed persistent-instance ranges to upload. */
  dirtyRangeCount: number;
  /** Number of changed slot lifecycle ranges. */
  stateDirtyRangeCount: number;
  /** Number of changed persistent bounds ranges. */
  boundsDirtyRangeCount: number;
  /** Number of changed persistent resource-key ranges. */
  resourceDirtyRangeCount: number;
  /** Whether the compact visible-slot mapping changed. */
  visibleSlotsDirty: boolean;
  /** Number of active candidates supplied to compute visibility. */
  candidateCount: number;
  /** Whether grouped candidate membership or order changed. */
  candidateSlotsDirty: boolean;
  /** Number of camera records to read from `cameraData`. */
  cameraCount: number;
  /** Whether camera records changed. */
  camerasDirty: boolean;
  /** Geometry handles ordered to match `instanceData`. */
  geometries: Uint32Array<ArrayBuffer>;
  /** Pipeline handles ordered to match `instanceData`. */
  pipelines: Uint32Array<ArrayBuffer>;
  /** Material handles ordered to match `instanceData`. */
  materials: Uint32Array<ArrayBuffer>;
  /** Persistent instance slots ordered for the compact visible draw list. */
  visibleSlots: Uint32Array<ArrayBuffer>;
  /** Geometry handles grouped for uncullled GPU visibility candidates. */
  candidateGeometries: Uint32Array<ArrayBuffer>;
  /** Pipeline identifiers grouped for GPU visibility candidates. */
  candidatePipelines: Uint32Array<ArrayBuffer>;
  /** Material handles grouped for GPU visibility candidates. */
  candidateMaterials: Uint32Array<ArrayBuffer>;
  /** Persistent slot indices grouped for GPU visibility candidates. */
  candidateSlots: Uint32Array<ArrayBuffer>;
  /** Packed model-matrix/color records indexed by persistent entity slot. */
  instanceData: Float32Array<ArrayBuffer>;
  /** Packed lifecycle records indexed by persistent entity slot. */
  slotStates: Uint32Array<ArrayBuffer>;
  /** World-space sphere records indexed by persistent entity slot. */
  slotBounds: Float32Array<ArrayBuffer>;
  /** Packed resource keys indexed by persistent entity slot. */
  slotResources: Uint32Array<ArrayBuffer>;
  /** Starts of coalesced changed persistent-instance ranges. */
  dirtyRangeStarts: Uint32Array<ArrayBuffer>;
  /** Counts of coalesced changed persistent-instance ranges. */
  dirtyRangeCounts: Uint32Array<ArrayBuffer>;
  stateDirtyRangeStarts: Uint32Array<ArrayBuffer>;
  stateDirtyRangeCounts: Uint32Array<ArrayBuffer>;
  boundsDirtyRangeStarts: Uint32Array<ArrayBuffer>;
  boundsDirtyRangeCounts: Uint32Array<ArrayBuffer>;
  resourceDirtyRangeStarts: Uint32Array<ArrayBuffer>;
  resourceDirtyRangeCounts: Uint32Array<ArrayBuffer>;
  /** Packed view/projection camera records. */
  cameraData: Float32Array<ArrayBuffer>;
}

/** Measurements collected from the most recently encoded frame. */
export interface RendererStats {
  /** Total bytes held by renderer-owned GPU buffers. */
  readonly gpuBufferBytes: number;
  /** Indexed draw calls submitted for the frame. */
  readonly drawCalls: number;
  /** Compute dispatches submitted for GPU visibility. */
  readonly computeDispatches: number;
  /** Indirect indexed draws submitted for the frame. */
  readonly indirectDrawCalls: number;
  /** Visibility path selected for this renderer. */
  readonly visibilityBackend: "cpu" | "gpu";
  /** Latest pull-sampled GPU-visible count, or `null` before a sample completes. */
  readonly gpuVisibleObjects: number | null;
  /** Matching CPU-oracle count captured for the same sampled frame. */
  readonly cpuVisibleObjects: number | null;
  /** Order-independent hash of the latest pull-sampled GPU membership. */
  readonly gpuVisibilityHash: number | null;
  /** Matching CPU-oracle hash captured for the same sampled frame. */
  readonly cpuVisibilityHash: number | null;
  /** Visible instances submitted to WebGPU. */
  readonly submittedInstances: number;
  /** CPU duration of buffer writes in milliseconds. */
  readonly bufferUploadCpuTimeMs: number;
  /** CPU-to-GPU bytes written during the most recent frame. */
  readonly bufferUploadBytes: number;
  /** `GPUQueue.writeBuffer` calls issued during the most recent frame. */
  readonly bufferWriteCount: number;
  /** Upload bytes grouped by persistent scene domain. */
  readonly uploadBytesByDomain: Readonly<{
    instances: number;
    slotState: number;
    bounds: number;
    resources: number;
    visibility: number;
    cameras: number;
    indirect: number;
  }>;
  /** Total CPU duration of renderer upload, preparation, encoding, and submission. */
  readonly framePreparationCpuTimeMs: number;
  /** Timestamp-query duration, or null when unsupported/unavailable. */
  readonly gpuTimeMs: number | null;
  /** WebGPU objects necessarily created for the most recently encoded frame. */
  readonly browserObjectsPerFrame: number;
}

/** Stable timings written only when a frame requests split CPU instrumentation. */
export interface RendererFrameTimings {
  readonly bufferUploadCpuTimeMs: number;
  readonly renderPreparationCpuTimeMs: number;
  readonly commandEncodingCpuTimeMs: number;
  readonly queueSubmitCpuTimeMs: number;
}

type MutableRendererFrameTimings = {
  -readonly [Stage in keyof RendererFrameTimings]: RendererFrameTimings[Stage];
};

export interface MeshRenderer {
  /** Reused split timings for the most recent explicitly sampled frame. */
  readonly frameTimings: RendererFrameTimings;
  /** Resolves when the owned GPU device is lost. */
  readonly lost: Promise<GPUDeviceLostInfo>;
  /** Registers a built-in geometry under a worker-owned generational key. */
  registerGeometry(handle: number, builtin: "triangle" | "cube"): void;
  /** Removes a matching geometry generation from future submissions. */
  removeGeometry(handle: number): void;
  /** Registers a basic-material key used by extracted draw runs. */
  registerBasicMaterial(handle: number): void;
  /** Removes a matching material generation from future submissions. */
  removeBasicMaterial(handle: number): void;
  /** Uploads and renders one extracted frame. */
  execute(frame: RenderFrame, profileStages?: boolean): void;
  /** Reconfigures the surface and depth attachment if physical size changed. */
  resize(size: SurfaceSize): void;
  /** Returns current measurements and requests one timestamp sample from a following frame. */
  stats(): RendererStats;
  /** Releases every renderer-owned GPU resource; safe to call repeatedly. */
  dispose(): void;
}

interface RendererState {
  readonly device: GPUDevice;
  readonly instanceCapacity: number;
  readonly surface: SurfaceState;
  readonly pipeline: GPURenderPipeline;
  readonly visibilityPipelines: VisibilityPipelines;
  readonly pipelineCache: PipelineCache;
  readonly meshes: MeshRegistry;
  readonly materials: MaterialRegistry;
  readonly cameraBuffer: GPUBuffer;
  readonly instanceBuffer: GPUBuffer;
  readonly visibleSlotBuffer: GPUBuffer;
  readonly slotStateBuffer: GPUBuffer;
  readonly slotBoundsBuffer: GPUBuffer;
  readonly slotResourceBuffer: GPUBuffer;
  readonly candidateSlotBuffer: GPUBuffer;
  readonly candidateRunIdBuffer: GPUBuffer;
  readonly indirectBuffer: GPUBuffer;
  readonly visibilityParameterBuffer: GPUBuffer;
  readonly indirectReadbackBuffer: GPUBuffer;
  readonly visibleReadbackBuffer: GPUBuffer;
  readonly bindGroup: GPUBindGroup;
  readonly visibilityBindGroup: GPUBindGroup;
  readonly profiler: GpuTimestampProfiler;
  readonly frameTimings: MutableRendererFrameTimings;
  readonly clearColor: GPUColor;
  colorAttachment: GPURenderPassColorAttachment | undefined;
  readonly depthAttachment: GPURenderPassDepthStencilAttachment;
  passDescriptor: GPURenderPassDescriptor | undefined;
  timestampPassDescriptor: GPURenderPassDescriptor | undefined;
  readonly submissions: GPUCommandBuffer[];
  readonly candidateRunIds: Uint32Array<ArrayBuffer>;
  readonly indirectWords: Uint32Array<ArrayBuffer>;
  readonly visibilityParameters: Uint32Array<ArrayBuffer>;
  readonly visibilityParameterFloats: Float32Array<ArrayBuffer>;
  readonly viewProjection: Float32Array<ArrayBuffer>;
  readonly runStarts: Uint32Array<ArrayBuffer>;
  readonly runCounts: Uint32Array<ArrayBuffer>;
  readonly runPipelines: Uint32Array<ArrayBuffer>;
  readonly runResourcesValid: Uint8Array<ArrayBuffer>;
  readonly runMeshes: Array<GpuMesh | undefined>;
  readonly visibilityMode: "cpu" | "gpu";
  readonly uploadBytesByDomain: {
    instances: number;
    slotState: number;
    bounds: number;
    resources: number;
    visibility: number;
    cameras: number;
    indirect: number;
  };
  runCount: number;
  visibilitySampleRequested: boolean;
  visibilityReadbackPending: boolean;
  visibilityReadbackEncoded: boolean;
  visibilitySampleRunCount: number;
  visibilitySampleCpuCount: number;
  visibilitySampleCpuHash: number;
  gpuVisibleObjects: number | null;
  cpuVisibleObjects: number | null;
  gpuVisibilityHash: number | null;
  cpuVisibilityHash: number | null;
  drawCalls: number;
  computeDispatches: number;
  indirectDrawCalls: number;
  submittedInstances: number;
  bufferUploadCpuTimeMs: number;
  bufferUploadBytes: number;
  bufferWriteCount: number;
  framePreparationCpuTimeMs: number;
  browserObjectsPerFrame: number;
  disposed: boolean;
}

interface RendererFrameContext {
  readonly state: RendererState;
  frame: RenderFrame | undefined;
  preparationStart: number;
  profileStages: boolean;
  encoder: GPUCommandEncoder | undefined;
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
  resourceCapacity = instanceCapacity,
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
  let materials: MaterialRegistry | undefined;
  let profiler: GpuTimestampProfiler | undefined;
  let cameraBuffer: GPUBuffer | undefined;
  let instanceBuffer: GPUBuffer | undefined;
  let visibleSlotBuffer: GPUBuffer | undefined;
  let slotStateBuffer: GPUBuffer | undefined;
  let slotBoundsBuffer: GPUBuffer | undefined;
  let slotResourceBuffer: GPUBuffer | undefined;
  let candidateSlotBuffer: GPUBuffer | undefined;
  let candidateRunIdBuffer: GPUBuffer | undefined;
  let indirectBuffer: GPUBuffer | undefined;
  let visibilityParameterBuffer: GPUBuffer | undefined;
  let indirectReadbackBuffer: GPUBuffer | undefined;
  let visibleReadbackBuffer: GPUBuffer | undefined;
  try {
    const instanceBytes = Math.max(INSTANCE_BYTES, instanceCapacity * INSTANCE_BYTES);
    const slotRecordBytes = Math.max(SLOT_RECORD_BYTES, instanceCapacity * SLOT_RECORD_BYTES);
    const visibleSlotBytes = Math.max(VISIBLE_SLOT_BYTES, instanceCapacity * VISIBLE_SLOT_BYTES);
    const indirectBytes = Math.max(INDIRECT_BYTES, instanceCapacity * INDIRECT_BYTES);
    validateStorageBufferSize(device.limits, "instance", instanceBytes);
    validateStorageBufferSize(device.limits, "slot record", slotRecordBytes);
    validateStorageBufferSize(device.limits, "visible slot", visibleSlotBytes);
    validateStorageBufferSize(device.limits, "indirect command", indirectBytes);

    surface = createSurface(device, canvas, size, options.alphaMode ?? "opaque");
    const meshPipelineLayout = createMeshPipelineLayout(device);
    const pipeline = await getMeshPipeline(
      device,
      pipelineCache,
      surface.format,
      meshPipelineLayout.pipelineLayout,
    );
    const visibilityPipelines = await createVisibilityPipelines(device);
    meshes = createMeshRegistry(device, resourceCapacity);
    materials = createMaterialRegistry(resourceCapacity);
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
    visibleSlotBuffer = device.createBuffer({
      label: "Lume visible instance slots",
      size: visibleSlotBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    slotStateBuffer = device.createBuffer({
      label: "Lume persistent slot state",
      size: slotRecordBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    slotBoundsBuffer = device.createBuffer({
      label: "Lume persistent slot bounds",
      size: slotRecordBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    slotResourceBuffer = device.createBuffer({
      label: "Lume persistent slot resources",
      size: slotRecordBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    candidateSlotBuffer = device.createBuffer({
      label: "Lume GPU visibility candidates",
      size: visibleSlotBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    candidateRunIdBuffer = device.createBuffer({
      label: "Lume candidate draw-run IDs",
      size: visibleSlotBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    indirectBuffer = device.createBuffer({
      label: "Lume indexed indirect commands",
      size: indirectBytes,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.INDIRECT |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC,
    });
    visibilityParameterBuffer = device.createBuffer({
      label: "Lume visibility parameters",
      size: VISIBILITY_PARAMETER_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    indirectReadbackBuffer = device.createBuffer({
      label: "Lume diagnostic indirect readback",
      size: indirectBytes,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    visibleReadbackBuffer = device.createBuffer({
      label: "Lume diagnostic visibility readback",
      size: visibleSlotBytes,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const visibilityBindGroup = device.createBindGroup({
      label: "Lume compute visibility bind group",
      layout: visibilityPipelines.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: cameraBuffer } },
        { binding: 1, resource: { buffer: slotStateBuffer } },
        { binding: 2, resource: { buffer: slotBoundsBuffer } },
        { binding: 3, resource: { buffer: slotResourceBuffer } },
        { binding: 4, resource: { buffer: candidateSlotBuffer } },
        { binding: 5, resource: { buffer: candidateRunIdBuffer } },
        { binding: 6, resource: { buffer: visibleSlotBuffer } },
        { binding: 7, resource: { buffer: indirectBuffer } },
        { binding: 8, resource: { buffer: visibilityParameterBuffer } },
      ],
    });
    const bindGroup = device.createBindGroup({
      label: "Lume frame bind group",
      layout: meshPipelineLayout.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: cameraBuffer } },
        { binding: 1, resource: { buffer: instanceBuffer } },
        { binding: 2, resource: { buffer: visibleSlotBuffer } },
      ],
    });
    device.queue.writeBuffer(cameraBuffer, 0, DEFAULT_CAMERA);

    const depthAttachment: GPURenderPassDepthStencilAttachment = {
      view: surface.depthView,
      depthClearValue: 1,
      depthLoadOp: "clear",
      depthStoreOp: "discard",
    };
    const visibilityParameters = new Uint32Array(VISIBILITY_PARAMETER_WORDS);
    const state: RendererState = {
      device,
      instanceCapacity,
      surface,
      pipeline,
      visibilityPipelines,
      pipelineCache,
      meshes,
      materials,
      cameraBuffer,
      instanceBuffer,
      visibleSlotBuffer,
      slotStateBuffer,
      slotBoundsBuffer,
      slotResourceBuffer,
      candidateSlotBuffer,
      candidateRunIdBuffer,
      indirectBuffer,
      visibilityParameterBuffer,
      indirectReadbackBuffer,
      visibleReadbackBuffer,
      bindGroup,
      visibilityBindGroup,
      profiler,
      frameTimings: {
        bufferUploadCpuTimeMs: 0,
        renderPreparationCpuTimeMs: 0,
        commandEncodingCpuTimeMs: 0,
        queueSubmitCpuTimeMs: 0,
      },
      clearColor: options.clearColor ?? { r: 0.018, g: 0.024, b: 0.04, a: 1 },
      colorAttachment: undefined,
      depthAttachment,
      passDescriptor: undefined,
      timestampPassDescriptor: undefined,
      submissions: new Array<GPUCommandBuffer>(1),
      candidateRunIds: new Uint32Array(instanceCapacity),
      indirectWords: new Uint32Array(instanceCapacity * INDIRECT_WORDS),
      visibilityParameters,
      visibilityParameterFloats: new Float32Array(visibilityParameters.buffer),
      viewProjection: new Float32Array(16),
      runStarts: new Uint32Array(instanceCapacity),
      runCounts: new Uint32Array(instanceCapacity),
      runPipelines: new Uint32Array(instanceCapacity),
      runResourcesValid: new Uint8Array(instanceCapacity),
      runMeshes: new Array<GpuMesh | undefined>(instanceCapacity),
      visibilityMode: options.visibilityMode === "gpu" ? "gpu" : "cpu",
      uploadBytesByDomain: {
        instances: 0,
        slotState: 0,
        bounds: 0,
        resources: 0,
        visibility: 0,
        cameras: 0,
        indirect: 0,
      },
      runCount: 0,
      visibilitySampleRequested: false,
      visibilityReadbackPending: false,
      visibilityReadbackEncoded: false,
      visibilitySampleRunCount: 0,
      visibilitySampleCpuCount: 0,
      visibilitySampleCpuHash: 0,
      gpuVisibleObjects: null,
      cpuVisibleObjects: null,
      gpuVisibilityHash: null,
      cpuVisibilityHash: null,
      drawCalls: 0,
      computeDispatches: 0,
      indirectDrawCalls: 0,
      submittedInstances: 0,
      bufferUploadCpuTimeMs: 0,
      bufferUploadBytes: 0,
      bufferWriteCount: 0,
      framePreparationCpuTimeMs: 0,
      browserObjectsPerFrame: 0,
      disposed: false,
    };
    const frameGraph = createRendererFrameGraph();
    const frameContext: RendererFrameContext = {
      state,
      frame: undefined,
      preparationStart: 0,
      profileStages: false,
      encoder: undefined,
    };

    const renderer: MeshRenderer = {
      lost: device.lost,
      frameTimings: state.frameTimings,
      registerGeometry(handle, builtin) {
        const source = builtinGeometrySource(builtin);
        state.meshes.register(handle, source);
      },
      removeGeometry(handle) {
        if (!state.meshes.remove(handle)) throw new Error(`Unknown geometry handle: ${handle}`);
      },
      registerBasicMaterial: (handle) => state.materials.register(handle),
      removeBasicMaterial(handle) {
        if (!state.materials.remove(handle)) throw new Error(`Unknown material handle: ${handle}`);
      },
      execute(frame, profileStages = false) {
        if (state.disposed) return;
        validateFrameCount("instanceCount", frame.instanceCount, state.instanceCapacity);
        validateFrameCount("candidateCount", frame.candidateCount, state.instanceCapacity);
        frameContext.frame = frame;
        frameContext.preparationStart = performance.now();
        frameContext.profileStages = profileStages;
        frameContext.encoder = undefined;
        try {
          executeFrameGraph(frameGraph, frameContext);
        } finally {
          frameContext.encoder = undefined;
        }
      },
      resize: (nextSize) => resize(state, nextSize),
      stats: () => readStats(state),
      dispose: () => dispose(state),
    };
    return renderer;
  } catch (error) {
    instanceBuffer?.destroy();
    visibleSlotBuffer?.destroy();
    slotStateBuffer?.destroy();
    slotBoundsBuffer?.destroy();
    slotResourceBuffer?.destroy();
    candidateSlotBuffer?.destroy();
    candidateRunIdBuffer?.destroy();
    indirectBuffer?.destroy();
    visibilityParameterBuffer?.destroy();
    indirectReadbackBuffer?.destroy();
    visibleReadbackBuffer?.destroy();
    cameraBuffer?.destroy();
    if (profiler !== undefined) destroyGpuTimestampProfiler(profiler);
    meshes?.dispose();
    materials?.dispose();
    pipelineCache.clear();
    if (surface !== undefined) destroySurface(surface);
    device.destroy();
    throw error;
  }
}

function validateStorageBufferSize(
  limits: GPUSupportedLimits,
  label: string,
  byteLength: number,
): void {
  if (byteLength <= limits.maxBufferSize && byteLength <= limits.maxStorageBufferBindingSize) {
    return;
  }
  throw new RangeError(
    `Configured render capacity requires ${byteLength} bytes for the ${label} buffer, exceeding device limits (maxBufferSize=${limits.maxBufferSize}, maxStorageBufferBindingSize=${limits.maxStorageBufferBindingSize}).`,
  );
}

function validateFrameCount(label: string, count: number, capacity: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > capacity) {
    throw new RangeError(`${label} ${count} exceeds configured render capacity ${capacity}.`);
  }
}

function createRendererFrameGraph(): CompiledFrameGraph<RendererFrameContext> {
  const graph = createFrameGraph<RendererFrameContext>();
  const extractedFrame = addFrameResource(graph, "visible-render-items");
  const uploadedFrame = addFrameResource(graph, "gpu-frame-data");
  const visibleFrame = addFrameResource(graph, "gpu-visible-items");
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
      name: "compute-visibility",
      reads: [uploadedFrame],
      writes: [visibleFrame],
      execute: encodeVisibilityPass,
    }),
  );
  addFramePass(
    graph,
    defineFramePass({
      name: "main-render",
      reads: [visibleFrame],
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
  state.bufferUploadBytes = 0;
  state.bufferWriteCount = 0;
  state.uploadBytesByDomain.instances = 0;
  state.uploadBytesByDomain.slotState = 0;
  state.uploadBytesByDomain.bounds = 0;
  state.uploadBytesByDomain.resources = 0;
  state.uploadBytesByDomain.visibility = 0;
  state.uploadBytesByDomain.cameras = 0;
  state.uploadBytesByDomain.indirect = 0;
  uploadDirtyRanges(
    state,
    state.instanceBuffer,
    frame.instanceData,
    INSTANCE_BYTES,
    frame.dirtyRangeCount,
    frame.dirtyRangeStarts,
    frame.dirtyRangeCounts,
    "instances",
  );
  uploadDirtyRanges(
    state,
    state.slotStateBuffer,
    frame.slotStates,
    SLOT_RECORD_BYTES,
    frame.stateDirtyRangeCount,
    frame.stateDirtyRangeStarts,
    frame.stateDirtyRangeCounts,
    "slotState",
  );
  uploadDirtyRanges(
    state,
    state.slotBoundsBuffer,
    frame.slotBounds,
    SLOT_RECORD_BYTES,
    frame.boundsDirtyRangeCount,
    frame.boundsDirtyRangeStarts,
    frame.boundsDirtyRangeCounts,
    "bounds",
  );
  uploadDirtyRanges(
    state,
    state.slotResourceBuffer,
    frame.slotResources,
    SLOT_RECORD_BYTES,
    frame.resourceDirtyRangeCount,
    frame.resourceDirtyRangeStarts,
    frame.resourceDirtyRangeCounts,
    "resources",
  );
  if (
    state.visibilityMode === "cpu" &&
    (frame.visibleSlotsDirty || frame.resourceDirtyRangeCount > 0)
  ) {
    prepareCpuRuns(state, frame);
    if (frame.instanceCount > 0) {
      const byteLength = frame.instanceCount * VISIBLE_SLOT_BYTES;
      state.device.queue.writeBuffer(
        state.visibleSlotBuffer,
        0,
        frame.visibleSlots.buffer,
        frame.visibleSlots.byteOffset,
        byteLength,
      );
      recordUpload(state, "visibility", byteLength);
    }
  }
  if (state.visibilityMode === "gpu") {
    let visibilityParametersDirty = false;
    if (frame.candidateSlotsDirty) {
      prepareGpuRuns(state, frame);
      state.visibilityParameters[0] = frame.candidateCount;
      state.visibilityParameters[1] = state.runCount;
      visibilityParametersDirty = true;
      if (frame.candidateCount > 0) {
        const candidateBytes = frame.candidateCount * VISIBLE_SLOT_BYTES;
        state.device.queue.writeBuffer(
          state.candidateSlotBuffer,
          0,
          frame.candidateSlots.buffer,
          frame.candidateSlots.byteOffset,
          candidateBytes,
        );
        state.device.queue.writeBuffer(
          state.candidateRunIdBuffer,
          0,
          state.candidateRunIds.buffer,
          0,
          candidateBytes,
        );
        recordUpload(state, "visibility", candidateBytes * 2);
        state.bufferWriteCount += 1;
      }
      if (state.runCount > 0) {
        const indirectBytes = state.runCount * INDIRECT_BYTES;
        state.device.queue.writeBuffer(
          state.indirectBuffer,
          0,
          state.indirectWords.buffer,
          0,
          indirectBytes,
        );
        recordUpload(state, "indirect", indirectBytes);
      }
    }
    if (frame.cameraCount > 0 && frame.camerasDirty) {
      writeFrustumPlanes(
        state.visibilityParameterFloats,
        FRUSTUM_PLANE_OFFSET,
        frame.cameraData,
        state.viewProjection,
      );
      visibilityParametersDirty = true;
    }
    if (visibilityParametersDirty) {
      state.device.queue.writeBuffer(
        state.visibilityParameterBuffer,
        0,
        state.visibilityParameters,
      );
      recordUpload(state, "visibility", VISIBILITY_PARAMETER_BYTES);
    }
  }
  if (frame.cameraCount > 0 && frame.camerasDirty) {
    state.device.queue.writeBuffer(
      state.cameraBuffer,
      0,
      frame.cameraData.buffer,
      frame.cameraData.byteOffset,
      CAMERA_BYTES,
    );
    recordUpload(state, "cameras", CAMERA_BYTES);
  }
  state.bufferUploadCpuTimeMs = performance.now() - uploadStart;
  if (context.profileStages) {
    state.frameTimings.bufferUploadCpuTimeMs = state.bufferUploadCpuTimeMs;
  }
}

function encodeVisibilityPass(context: RendererFrameContext): void {
  const { state, frame } = context;
  if (frame === undefined) throw new Error("Renderer frame context is not initialized.");
  state.computeDispatches = 0;
  if (state.visibilityMode !== "gpu" || state.runCount === 0 || frame.candidateCount === 0) {
    return;
  }
  const encoder = state.device.createCommandEncoder({ label: "Lume frame commands" });
  const pass = encoder.beginComputePass({ label: "Lume compute visibility" });
  pass.setBindGroup(0, state.visibilityBindGroup);
  pass.setPipeline(state.visibilityPipelines.reset);
  pass.dispatchWorkgroups(Math.ceil(state.runCount / 64));
  pass.setPipeline(state.visibilityPipelines.cull);
  pass.dispatchWorkgroups(Math.ceil(frame.candidateCount / 64));
  pass.end();
  context.encoder = encoder;
  state.computeDispatches = 2;
}

function uploadDirtyRanges(
  state: RendererState,
  buffer: GPUBuffer,
  source: Uint32Array<ArrayBuffer> | Float32Array<ArrayBuffer>,
  recordBytes: number,
  rangeCount: number,
  starts: Uint32Array<ArrayBuffer>,
  counts: Uint32Array<ArrayBuffer>,
  domain: "instances" | "slotState" | "bounds" | "resources",
): void {
  for (let range = 0; range < rangeCount; range += 1) {
    const start = starts[range] ?? 0;
    const count = counts[range] ?? 0;
    if (count === 0) continue;
    const byteOffset = start * recordBytes;
    const byteLength = count * recordBytes;
    state.device.queue.writeBuffer(
      buffer,
      byteOffset,
      source.buffer,
      source.byteOffset + byteOffset,
      byteLength,
    );
    recordUpload(state, domain, byteLength);
  }
}

function recordUpload(
  state: RendererState,
  domain: keyof RendererState["uploadBytesByDomain"],
  bytes: number,
): void {
  state.uploadBytesByDomain[domain] += bytes;
  state.bufferUploadBytes += bytes;
  state.bufferWriteCount += 1;
}

function prepareGpuRuns(state: RendererState, frame: RenderFrame): void {
  prepareRuns(
    state,
    frame.candidateCount,
    frame.candidateGeometries,
    frame.candidatePipelines,
    frame.candidateMaterials,
    true,
  );
}

function prepareCpuRuns(state: RendererState, frame: RenderFrame): void {
  prepareRuns(
    state,
    frame.instanceCount,
    frame.geometries,
    frame.pipelines,
    frame.materials,
    false,
  );
}

function prepareRuns(
  state: RendererState,
  itemCount: number,
  geometries: Uint32Array<ArrayBuffer>,
  pipelines: Uint32Array<ArrayBuffer>,
  materials: Uint32Array<ArrayBuffer>,
  prepareIndirect: boolean,
): void {
  let candidate = 0;
  let run = 0;
  while (candidate < itemCount) {
    const geometry = geometries[candidate] ?? 0;
    const pipeline = pipelines[candidate] ?? 0;
    let resourcesValid = state.materials.has(materials[candidate] ?? 0);
    let runEnd = candidate + 1;
    while (
      runEnd < itemCount &&
      geometries[runEnd] === geometry &&
      pipelines[runEnd] === pipeline
    ) {
      resourcesValid = resourcesValid && state.materials.has(materials[runEnd] ?? 0);
      runEnd += 1;
    }
    const mesh = state.meshes.get(geometry);
    state.runStarts[run] = candidate;
    state.runCounts[run] = runEnd - candidate;
    state.runPipelines[run] = pipeline;
    state.runResourcesValid[run] = resourcesValid ? 1 : 0;
    state.runMeshes[run] = mesh;
    if (prepareIndirect) {
      state.candidateRunIds.fill(run, candidate, runEnd);
      const indirectOffset = run * INDIRECT_WORDS;
      state.indirectWords[indirectOffset] = mesh?.indexCount ?? 0;
      state.indirectWords[indirectOffset + 1] = 0;
      state.indirectWords[indirectOffset + 2] = 0;
      state.indirectWords[indirectOffset + 3] = 0;
      state.indirectWords[indirectOffset + 4] = candidate;
    }
    run += 1;
    candidate = runEnd;
  }
  state.runCount = run;
}

function encodeMainPass(context: RendererFrameContext): void {
  const { state, frame } = context;
  if (frame === undefined) throw new Error("Renderer frame context is not initialized.");
  const preparationStart = context.profileStages ? performance.now() : 0;
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
  const timestampSample = beginGpuTimestampSample(state.profiler);
  const passDescriptor = state.passDescriptor ?? {
    label: "Lume main render pass",
    colorAttachments: [colorAttachment],
    depthStencilAttachment: state.depthAttachment,
  };
  state.passDescriptor = passDescriptor;
  const timestampWrites = state.profiler.timestampWrites;
  const activePassDescriptor =
    timestampSample && timestampWrites !== undefined
      ? (state.timestampPassDescriptor ?? {
          ...passDescriptor,
          timestampWrites,
        })
      : passDescriptor;
  if (timestampSample && timestampWrites !== undefined) {
    state.timestampPassDescriptor = activePassDescriptor;
  }
  if (context.profileStages) {
    state.frameTimings.renderPreparationCpuTimeMs = performance.now() - preparationStart;
  }
  const encodingStart = context.profileStages ? performance.now() : 0;
  const encoder =
    context.encoder ?? state.device.createCommandEncoder({ label: "Lume frame commands" });
  const pass = encoder.beginRenderPass(activePassDescriptor);
  // WebGPU mandates these frame-scoped objects: surface texture/view, command
  // encoder, render pass encoder, and command buffer. Engine-owned arrays and
  // descriptors remain reusable and are deliberately not included.
  state.browserObjectsPerFrame =
    state.visibilityMode === "gpu" && state.computeDispatches > 0 ? 6 : 5;
  pass.setPipeline(state.pipeline);
  pass.setBindGroup(0, state.bindGroup);

  let drawCalls = 0;
  if (state.visibilityMode === "gpu") {
    for (let run = 0; run < state.runCount; run += 1) {
      const pipeline = state.runPipelines[run] ?? 0;
      const mesh = state.runMeshes[run];
      if (
        pipeline === BASIC_PIPELINE_ID &&
        mesh !== undefined &&
        state.runResourcesValid[run] !== 0
      ) {
        pass.setVertexBuffer(0, mesh.vertexBuffer);
        pass.setIndexBuffer(mesh.indexBuffer, "uint32");
        pass.drawIndexedIndirect(state.indirectBuffer, run * INDIRECT_BYTES);
        drawCalls += 1;
      }
    }
    state.indirectDrawCalls = drawCalls;
  } else {
    for (let run = 0; run < state.runCount; run += 1) {
      const pipeline = state.runPipelines[run] ?? 0;
      const mesh = state.runMeshes[run];
      if (
        pipeline === BASIC_PIPELINE_ID &&
        mesh !== undefined &&
        state.runResourcesValid[run] !== 0
      ) {
        pass.setVertexBuffer(0, mesh.vertexBuffer);
        pass.setIndexBuffer(mesh.indexBuffer, "uint32");
        pass.drawIndexed(
          mesh.indexCount,
          state.runCounts[run] ?? 0,
          0,
          0,
          state.runStarts[run] ?? 0,
        );
        drawCalls += 1;
      }
    }
    state.indirectDrawCalls = 0;
  }
  pass.end();
  encodeVisibilityReadback(state, frame, encoder);
  const timestampReadback = encodeGpuTimestampResolve(state.profiler, encoder, timestampSample);
  state.submissions[0] = encoder.finish();
  context.encoder = undefined;
  if (context.profileStages) {
    state.frameTimings.commandEncodingCpuTimeMs = performance.now() - encodingStart;
  }
  const submissionStart = context.profileStages ? performance.now() : 0;
  state.device.queue.submit(state.submissions);
  if (context.profileStages) {
    state.frameTimings.queueSubmitCpuTimeMs = performance.now() - submissionStart;
  }
  requestGpuTimestampRead(state.profiler, timestampReadback);
  beginVisibilityReadback(state);
  state.drawCalls = drawCalls;
  state.submittedInstances = state.visibilityMode === "gpu" ? frame.candidateCount : instanceCount;
  state.framePreparationCpuTimeMs = performance.now() - context.preparationStart;
}

function encodeVisibilityReadback(
  state: RendererState,
  frame: RenderFrame,
  encoder: GPUCommandEncoder,
): void {
  state.visibilityReadbackEncoded = false;
  if (
    state.visibilityMode !== "gpu" ||
    !state.visibilitySampleRequested ||
    state.visibilityReadbackPending
  ) {
    return;
  }
  state.visibilitySampleRequested = false;
  state.visibilitySampleCpuCount = frame.instanceCount;
  state.visibilitySampleCpuHash = membershipHash(frame.visibleSlots, frame.instanceCount);
  state.visibilitySampleRunCount = state.runCount;
  if (state.runCount === 0 || frame.candidateCount === 0) {
    state.gpuVisibleObjects = 0;
    state.cpuVisibleObjects = state.visibilitySampleCpuCount;
    state.gpuVisibilityHash = membershipHash(frame.visibleSlots, 0);
    state.cpuVisibilityHash = state.visibilitySampleCpuHash;
    return;
  }
  encoder.copyBufferToBuffer(
    state.indirectBuffer,
    0,
    state.indirectReadbackBuffer,
    0,
    state.runCount * INDIRECT_BYTES,
  );
  encoder.copyBufferToBuffer(
    state.visibleSlotBuffer,
    0,
    state.visibleReadbackBuffer,
    0,
    frame.candidateCount * VISIBLE_SLOT_BYTES,
  );
  state.visibilityReadbackEncoded = true;
  state.visibilityReadbackPending = true;
}

function beginVisibilityReadback(state: RendererState): void {
  if (!state.visibilityReadbackEncoded) return;
  state.visibilityReadbackEncoded = false;
  void Promise.all([
    state.indirectReadbackBuffer.mapAsync(GPUMapMode.READ),
    state.visibleReadbackBuffer.mapAsync(GPUMapMode.READ),
  ])
    .then(() => {
      if (state.disposed) return;
      const commands = new Uint32Array(state.indirectReadbackBuffer.getMappedRange());
      const visible = new Uint32Array(state.visibleReadbackBuffer.getMappedRange());
      let count = 0;
      let hash = 0x811c9dc5;
      for (let run = 0; run < state.visibilitySampleRunCount; run += 1) {
        const commandOffset = run * INDIRECT_WORDS;
        const instances = commands[commandOffset + 1] ?? 0;
        const firstInstance = commands[commandOffset + 4] ?? 0;
        count += instances;
        for (let instance = 0; instance < instances; instance += 1) {
          hash = mixMembershipHash(hash, visible[firstInstance + instance] ?? 0);
        }
      }
      state.gpuVisibleObjects = count;
      state.cpuVisibleObjects = state.visibilitySampleCpuCount;
      state.gpuVisibilityHash = hash >>> 0;
      state.cpuVisibilityHash = state.visibilitySampleCpuHash;
    })
    .catch(() => {
      state.gpuVisibleObjects = null;
      state.cpuVisibleObjects = null;
      state.gpuVisibilityHash = null;
      state.cpuVisibilityHash = null;
    })
    .finally(() => {
      if (!state.disposed) {
        unmapBufferSafely(state.indirectReadbackBuffer);
        unmapBufferSafely(state.visibleReadbackBuffer);
      }
      state.visibilityReadbackPending = false;
    });
}

function membershipHash(slots: Uint32Array<ArrayBuffer>, count: number): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < count; index += 1) {
    hash = mixMembershipHash(hash, slots[index] ?? 0);
  }
  return hash >>> 0;
}

function mixMembershipHash(hash: number, slot: number): number {
  return (hash ^ Math.imul(slot ^ 0x9e37_79b9, 0x0100_0193)) >>> 0;
}

function readStats(state: RendererState): RendererStats {
  const stats: RendererStats = {
    gpuBufferBytes:
      state.meshes.gpuBytes +
      state.cameraBuffer.size +
      state.instanceBuffer.size +
      state.visibleSlotBuffer.size +
      state.slotStateBuffer.size +
      state.slotBoundsBuffer.size +
      state.slotResourceBuffer.size +
      state.candidateSlotBuffer.size +
      state.candidateRunIdBuffer.size +
      state.indirectBuffer.size +
      state.visibilityParameterBuffer.size +
      state.indirectReadbackBuffer.size +
      state.visibleReadbackBuffer.size +
      state.profiler.gpuBytes,
    drawCalls: state.drawCalls,
    computeDispatches: state.computeDispatches,
    indirectDrawCalls: state.indirectDrawCalls,
    visibilityBackend: state.visibilityMode,
    gpuVisibleObjects: state.gpuVisibleObjects,
    cpuVisibleObjects: state.cpuVisibleObjects,
    gpuVisibilityHash: state.gpuVisibilityHash,
    cpuVisibilityHash: state.cpuVisibilityHash,
    submittedInstances: state.submittedInstances,
    bufferUploadCpuTimeMs: state.bufferUploadCpuTimeMs,
    bufferUploadBytes: state.bufferUploadBytes,
    bufferWriteCount: state.bufferWriteCount,
    uploadBytesByDomain: state.uploadBytesByDomain,
    framePreparationCpuTimeMs: state.framePreparationCpuTimeMs,
    gpuTimeMs: state.profiler.gpuTimeMs,
    browserObjectsPerFrame: state.browserObjectsPerFrame,
  };
  requestGpuTimestampSample(state.profiler);
  state.visibilitySampleRequested = true;
  return stats;
}

function resize(state: RendererState, size: SurfaceSize): void {
  if (!state.disposed) resizeSurface(state.device, state.surface, size);
}

function dispose(state: RendererState): void {
  if (state.disposed) return;
  state.disposed = true;
  state.meshes.dispose();
  state.materials.dispose();
  destroyGpuTimestampProfiler(state.profiler);
  state.cameraBuffer.destroy();
  state.instanceBuffer.destroy();
  state.visibleSlotBuffer.destroy();
  state.slotStateBuffer.destroy();
  state.slotBoundsBuffer.destroy();
  state.slotResourceBuffer.destroy();
  state.candidateSlotBuffer.destroy();
  state.candidateRunIdBuffer.destroy();
  state.indirectBuffer.destroy();
  state.visibilityParameterBuffer.destroy();
  state.indirectReadbackBuffer.destroy();
  state.visibleReadbackBuffer.destroy();
  state.pipelineCache.clear();
  destroySurface(state.surface);
  state.device.destroy();
}

function builtinGeometrySource(builtin: "triangle" | "cube") {
  for (const source of BUILTIN_MESHES) {
    if (source.builtin === builtin) return source;
  }
  throw new Error(`Unknown built-in geometry: ${builtin}`);
}
