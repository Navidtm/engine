import { describe, expect, it, vi } from "vitest";

import { createMeshRenderer, type RenderFrame } from "./mesh-renderer.js";
import type * as SurfaceModule from "./webgpu/surface.js";

const mocks = vi.hoisted(() => ({
  destroySurface: vi.fn(),
  createMeshPipelineLayout: vi.fn(() => ({ bindGroupLayout: {}, pipelineLayout: {} })),
  getMeshPipeline: vi.fn(),
  createVisibilityPipelines: vi.fn(),
  requestAdapter: vi.fn(),
  requestDevice: vi.fn(),
}));

vi.mock("./pipeline/mesh.js", () => ({
  createMeshPipelineLayout: mocks.createMeshPipelineLayout,
  getMeshPipeline: mocks.getMeshPipeline,
}));
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
      context: {
        getCurrentTexture: vi.fn(() => ({ createView: vi.fn(() => ({})) })),
      },
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

  it("reuses prepared CPU draw runs while visible membership is unchanged", async () => {
    vi.stubGlobal("GPUBufferUsage", {
      MAP_READ: 1,
      COPY_SRC: 2,
      COPY_DST: 4,
      UNIFORM: 8,
      STORAGE: 16,
      INDIRECT: 32,
      VERTEX: 64,
      INDEX: 128,
    });
    const renderPass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      setVertexBuffer: vi.fn(),
      setIndexBuffer: vi.fn(),
      drawIndexed: vi.fn(),
      end: vi.fn(),
    };
    const device = {
      features: new Set<GPUFeatureName>(),
      limits: {
        maxStorageBufferBindingSize: 1_000_000,
        maxBufferSize: 1_000_000,
      },
      queue: { writeBuffer: vi.fn(), submit: vi.fn() },
      createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
        const size = Number(descriptor.size);
        return {
          size,
          getMappedRange: vi.fn(() => new ArrayBuffer(size)),
          unmap: vi.fn(),
          destroy: vi.fn(),
        };
      }),
      createBindGroup: vi.fn(() => ({})),
      createCommandEncoder: vi.fn(() => ({
        beginRenderPass: vi.fn(() => renderPass),
        finish: vi.fn(() => ({})),
      })),
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
      { visibilityMode: "cpu" },
    );
    renderer.registerGeometry(1, "triangle");
    renderer.registerBasicMaterial(1);
    renderer.registerBasicMaterial(2);
    const frame = createRenderFrame(4);
    frame.instanceCount = 2;
    frame.visibleSlotsDirty = true;
    frame.geometries.set([1, 1]);
    frame.pipelines.set([1, 1]);
    frame.materials.set([1, 2]);
    renderer.execute(frame);

    frame.visibleSlotsDirty = false;
    frame.geometries = new Uint32Array(0);
    frame.pipelines = new Uint32Array(0);
    frame.materials = new Uint32Array(0);
    renderer.execute(frame);

    expect(renderPass.drawIndexed).toHaveBeenCalledTimes(2);
    const stats = renderer.stats();
    expect(stats.drawCalls).toBe(1);
    const mutableDomains = stats.uploadBytesByDomain as { instances: number };
    mutableDomains.instances = 999;
    expect(renderer.stats().uploadBytesByDomain.instances).not.toBe(999);
  });

  it("invalidates prepared runs before destroying their geometry buffers", async () => {
    vi.stubGlobal("GPUBufferUsage", {
      MAP_READ: 1,
      COPY_SRC: 2,
      COPY_DST: 4,
      UNIFORM: 8,
      STORAGE: 16,
      INDIRECT: 32,
      VERTEX: 64,
      INDEX: 128,
    });
    const renderPass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      setVertexBuffer: vi.fn(),
      setIndexBuffer: vi.fn(),
      drawIndexed: vi.fn(),
      end: vi.fn(),
    };
    const device = {
      features: new Set<GPUFeatureName>(),
      limits: {
        maxStorageBufferBindingSize: 1_000_000,
        maxBufferSize: 1_000_000,
      },
      queue: { writeBuffer: vi.fn(), submit: vi.fn() },
      createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
        const size = Number(descriptor.size);
        return {
          size,
          getMappedRange: vi.fn(() => new ArrayBuffer(size)),
          unmap: vi.fn(),
          destroy: vi.fn(),
        };
      }),
      createBindGroup: vi.fn(() => ({})),
      createCommandEncoder: vi.fn(() => ({
        beginRenderPass: vi.fn(() => renderPass),
        finish: vi.fn(() => ({})),
      })),
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
      2,
      { visibilityMode: "cpu" },
    );
    renderer.registerGeometry(1, "triangle");
    renderer.registerBasicMaterial(1);
    const frame = createRenderFrame(2);
    frame.instanceCount = 1;
    frame.visibleSlotsDirty = true;
    frame.geometries[0] = 1;
    frame.pipelines[0] = 1;
    frame.materials[0] = 1;
    renderer.execute(frame);
    const vertexBuffer = renderPass.setVertexBuffer.mock.calls[0]?.[1] as
      { destroy: ReturnType<typeof vi.fn> } | undefined;
    expect(vertexBuffer).toBeDefined();

    renderPass.setVertexBuffer.mockClear();
    renderPass.setIndexBuffer.mockClear();
    renderPass.drawIndexed.mockClear();
    renderer.removeGeometry(1);
    expect(vertexBuffer?.destroy).toHaveBeenCalledOnce();
    frame.visibleSlotsDirty = false;
    renderer.execute(frame);

    expect(renderPass.setVertexBuffer).not.toHaveBeenCalled();
    expect(renderPass.setIndexBuffer).not.toHaveBeenCalled();
    expect(renderPass.drawIndexed).not.toHaveBeenCalled();
  });

  it("rebuilds prepared CPU draw runs when resource keys change", async () => {
    vi.stubGlobal("GPUBufferUsage", {
      MAP_READ: 1,
      COPY_SRC: 2,
      COPY_DST: 4,
      UNIFORM: 8,
      STORAGE: 16,
      INDIRECT: 32,
      VERTEX: 64,
      INDEX: 128,
    });
    const renderPass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      setVertexBuffer: vi.fn(),
      setIndexBuffer: vi.fn(),
      drawIndexed: vi.fn(),
      end: vi.fn(),
    };
    const device = {
      features: new Set<GPUFeatureName>(),
      limits: {
        maxStorageBufferBindingSize: 1_000_000,
        maxBufferSize: 1_000_000,
      },
      queue: { writeBuffer: vi.fn(), submit: vi.fn() },
      createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
        const size = Number(descriptor.size);
        return {
          size,
          getMappedRange: vi.fn(() => new ArrayBuffer(size)),
          unmap: vi.fn(),
          destroy: vi.fn(),
        };
      }),
      createBindGroup: vi.fn(() => ({})),
      createCommandEncoder: vi.fn(() => ({
        beginRenderPass: vi.fn(() => renderPass),
        finish: vi.fn(() => ({})),
      })),
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
      { visibilityMode: "cpu" },
    );
    renderer.registerGeometry(1, "triangle");
    renderer.registerGeometry(2, "cube");
    renderer.registerBasicMaterial(1);
    const frame = createRenderFrame(4);
    frame.instanceCount = 2;
    frame.visibleSlotsDirty = true;
    frame.geometries.set([1, 1]);
    frame.pipelines.set([1, 1]);
    frame.materials.set([1, 1]);
    renderer.execute(frame);

    frame.visibleSlotsDirty = false;
    frame.resourceDirtyRangeCount = 1;
    frame.resourceDirtyRangeCounts[0] = 1;
    frame.geometries[1] = 2;
    renderer.execute(frame);

    expect(renderer.stats().drawCalls).toBe(2);
  });

  it("discards a frame encoder when encoding throws mid-frame", async () => {
    vi.stubGlobal("GPUBufferUsage", {
      MAP_READ: 1,
      COPY_SRC: 2,
      COPY_DST: 4,
      UNIFORM: 8,
      STORAGE: 16,
      INDIRECT: 32,
      VERTEX: 64,
      INDEX: 128,
    });
    const computePass = {
      setBindGroup: vi.fn(),
      setPipeline: vi.fn(),
      dispatchWorkgroups: vi.fn(),
      end: vi.fn(),
    };
    const renderPass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      setVertexBuffer: vi.fn(),
      setIndexBuffer: vi.fn(),
      drawIndexedIndirect: vi.fn(),
      end: vi.fn(),
    };
    const failedEncoder = {
      beginComputePass: vi.fn(() => computePass),
      beginRenderPass: vi.fn(() => {
        throw new Error("encoding failed");
      }),
      finish: vi.fn(),
    };
    const replacementEncoder = {
      beginComputePass: vi.fn(() => computePass),
      beginRenderPass: vi.fn(() => renderPass),
      finish: vi.fn(() => ({})),
    };
    const device = {
      features: new Set<GPUFeatureName>(),
      limits: {
        maxStorageBufferBindingSize: 1_000_000,
        maxBufferSize: 1_000_000,
      },
      queue: { writeBuffer: vi.fn(), submit: vi.fn() },
      createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
        const size = Number(descriptor.size);
        return {
          size,
          getMappedRange: vi.fn(() => new ArrayBuffer(size)),
          unmap: vi.fn(),
          destroy: vi.fn(),
        };
      }),
      createBindGroup: vi.fn(() => ({})),
      createCommandEncoder: vi
        .fn()
        .mockReturnValueOnce(failedEncoder)
        .mockReturnValueOnce(replacementEncoder),
      destroy: vi.fn(),
      lost: new Promise<GPUDeviceLostInfo>(() => undefined),
    } as unknown as GPUDevice;
    const pipeline = {} as GPURenderPipeline;
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
      2,
      { visibilityMode: "gpu" },
    );
    renderer.registerGeometry(1, "triangle");
    renderer.registerBasicMaterial(1);
    const frame = createRenderFrame(2);
    frame.candidateCount = 1;
    frame.candidateSlotsDirty = true;
    frame.candidateGeometries[0] = 1;
    frame.candidatePipelines[0] = 1;
    frame.candidateMaterials[0] = 1;

    expect(() => renderer.execute(frame)).toThrow("encoding failed");
    frame.candidateCount = 0;
    frame.candidateSlotsDirty = true;
    renderer.execute(frame);

    expect(device.createCommandEncoder).toHaveBeenCalledTimes(2);
    expect(failedEncoder.beginRenderPass).toHaveBeenCalledTimes(1);
    expect(replacementEncoder.beginRenderPass).toHaveBeenCalledTimes(1);
    expect(device.queue.submit).toHaveBeenCalledTimes(1);
  });
});

function createRenderFrame(capacity: number): RenderFrame {
  return {
    instanceCount: 0,
    dirtyRangeCount: 0,
    stateDirtyRangeCount: 0,
    boundsDirtyRangeCount: 0,
    resourceDirtyRangeCount: 0,
    visibleSlotsDirty: false,
    candidateCount: 0,
    candidateSlotsDirty: false,
    cameraCount: 0,
    camerasDirty: false,
    geometries: new Uint32Array(capacity),
    pipelines: new Uint32Array(capacity),
    materials: new Uint32Array(capacity),
    visibleSlots: new Uint32Array(capacity),
    candidateGeometries: new Uint32Array(capacity),
    candidatePipelines: new Uint32Array(capacity),
    candidateMaterials: new Uint32Array(capacity),
    candidateSlots: new Uint32Array(capacity),
    instanceData: new Float32Array(capacity * 20),
    slotStates: new Uint32Array(capacity * 4),
    slotBounds: new Float32Array(capacity * 4),
    slotResources: new Uint32Array(capacity * 4),
    dirtyRangeStarts: new Uint32Array(capacity),
    dirtyRangeCounts: new Uint32Array(capacity),
    stateDirtyRangeStarts: new Uint32Array(capacity),
    stateDirtyRangeCounts: new Uint32Array(capacity),
    boundsDirtyRangeStarts: new Uint32Array(capacity),
    boundsDirtyRangeCounts: new Uint32Array(capacity),
    resourceDirtyRangeStarts: new Uint32Array(capacity),
    resourceDirtyRangeCounts: new Uint32Array(capacity),
    cameraData: new Float32Array(32),
  };
}
