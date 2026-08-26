import type { MeshRenderer } from "@lume/renderer";
import { describe, expect, it, vi } from "vitest";

import {
  type MainToWorkerMessage,
  RUNTIME_PROTOCOL_VERSION,
  type WorkerToMainMessage,
} from "./protocol.js";
import type { WasmCore } from "./wasm.js";
import { createWorkerRuntime, type WorkerHost } from "./worker-runtime.js";

const mocks = vi.hoisted(() => ({
  createMeshRenderer: vi.fn(),
  createWasmCore: vi.fn(),
}));

vi.mock("@lume/renderer", () => ({ createMeshRenderer: mocks.createMeshRenderer }));
vi.mock("./wasm.js", () => ({ createWasmCore: mocks.createWasmCore }));

describe("worker external geometry integration", () => {
  it("fetches in the worker and returns a correlated typed decode failure", async () => {
    const renderer = createRenderer();
    const core = createCore();
    mocks.createMeshRenderer.mockResolvedValueOnce(renderer);
    mocks.createWasmCore.mockResolvedValueOnce(core);
    const posted: WorkerToMainMessage[] = [];
    const fetchGeometry = vi.fn(async () => new Response(new Uint8Array(20), { status: 200 }));
    const host: WorkerHost = {
      postMessage: (message) => posted.push(message),
      requestAnimationFrame: vi.fn(() => 1),
      cancelAnimationFrame: vi.fn(),
      fetch: fetchGeometry,
    };
    const receive = createWorkerRuntime(host);
    receive(initMessage());
    await vi.waitFor(() => expect(posted[0]?.type).toBe("ready"));

    receive({
      type: "load-geometry",
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      requestId: 41,
      handle: 1,
      source: "https://assets.test/malformed.glb",
    });

    await vi.waitFor(() =>
      expect(posted).toContainEqual(
        expect.objectContaining({
          type: "geometry-failed",
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          requestId: 41,
          handle: 1,
          error: expect.objectContaining({
            code: "LUME_ASSET_FORMAT",
            stage: "container",
          }),
        }),
      ),
    );
    expect(fetchGeometry).toHaveBeenCalledWith(
      "https://assets.test/malformed.glb",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(renderer.registerExternalGeometry).not.toHaveBeenCalled();
  });

  it("rejects later loads after renderer recovery fails", async () => {
    const lost = deferred<GPUDeviceLostInfo>();
    const renderer = createRenderer(lost.promise);
    const core = createCore();
    mocks.createMeshRenderer
      .mockResolvedValueOnce(renderer)
      .mockRejectedValueOnce(new Error("adapter unavailable"));
    mocks.createWasmCore.mockResolvedValueOnce(core);
    const posted: WorkerToMainMessage[] = [];
    const fetchGeometry = vi.fn();
    const host: WorkerHost = {
      postMessage: (message) => posted.push(message),
      requestAnimationFrame: vi.fn(() => 1),
      cancelAnimationFrame: vi.fn(),
      fetch: fetchGeometry,
    };
    const receive = createWorkerRuntime(host);
    receive(initMessage());
    await vi.waitFor(() => expect(posted[0]?.type).toBe("ready"));

    lost.resolve({ reason: "unknown", message: "test loss" } as GPUDeviceLostInfo);
    await vi.waitFor(() =>
      expect(posted).toContainEqual(
        expect.objectContaining({
          type: "device-lost",
          message: "test loss Recovery failed: adapter unavailable",
        }),
      ),
    );

    receive({
      type: "load-geometry",
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      requestId: 42,
      handle: 2,
      source: "https://assets.test/after-recovery-failure.glb",
    });
    receive({ type: "get-stats", requestId: 43 });

    expect(posted).toContainEqual({
      type: "geometry-failed",
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      requestId: 42,
      handle: 2,
      error: {
        code: "LUME_ASSET_ABORTED",
        stage: "lifecycle",
        message: "Geometry loader is disposed.",
      },
    });
    expect(fetchGeometry).not.toHaveBeenCalled();
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: "stats",
        requestId: 43,
        value: expect.objectContaining({
          assets: expect.objectContaining({
            pendingLoads: 0,
            temporaryReservedBytes: 0,
          }),
        }),
      }),
    );
  });

  it("parks a load during device recovery and publishes only to the replacement", async () => {
    const lost = deferred<GPUDeviceLostInfo>();
    const first = createRenderer(lost.promise);
    const replacement = createRenderer();
    const replacementResult = deferred<MeshRenderer>();
    const core = createCore();
    mocks.createMeshRenderer
      .mockResolvedValueOnce(first)
      .mockReturnValueOnce(replacementResult.promise);
    mocks.createWasmCore.mockResolvedValueOnce(core);
    const posted: WorkerToMainMessage[] = [];
    const fetchGeometry = vi.fn(async () => new Response(triangleGlb(), { status: 200 }));
    const host: WorkerHost = {
      postMessage: (message) => posted.push(message),
      requestAnimationFrame: vi.fn(() => 1),
      cancelAnimationFrame: vi.fn(),
      fetch: fetchGeometry,
    };
    const receive = createWorkerRuntime(host);
    receive(initMessage());
    await vi.waitFor(() => expect(posted[0]?.type).toBe("ready"));

    lost.resolve({ reason: "unknown", message: "interleaved loss" } as GPUDeviceLostInfo);
    await vi.waitFor(() => expect(first.dispose).toHaveBeenCalledOnce());
    receive({
      type: "load-geometry",
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      requestId: 44,
      handle: 1,
      source: "https://assets.test/recovery-interleave.glb",
    });
    await vi.waitFor(() => expect(fetchGeometry).toHaveBeenCalledOnce());
    expect(posted.some((message) => message.type === "geometry-ready")).toBe(false);

    replacementResult.resolve(replacement);

    await vi.waitFor(() =>
      expect(posted).toContainEqual(
        expect.objectContaining({ type: "geometry-ready", requestId: 44, handle: 1 }),
      ),
    );
    expect(first.registerExternalGeometry).not.toHaveBeenCalled();
    expect(replacement.registerExternalGeometry).toHaveBeenCalledWith(1, expect.any(Object));

    receive({ type: "get-stats", requestId: 45 });
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: "stats",
        requestId: 45,
        value: expect.objectContaining({
          assets: expect.objectContaining({
            pendingLoads: 0,
            successfulLoads: 1,
            temporaryReservedBytes: 0,
            retainedDecodedBytes: expect.any(Number),
          }),
        }),
      }),
    );
    const stats = posted.find(
      (message): message is Extract<WorkerToMainMessage, { type: "stats" }> =>
        message.type === "stats" && message.requestId === 45,
    );
    expect(stats?.value.assets.retainedDecodedBytes).toBeGreaterThan(0);
  });
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve: (value) => resolve?.(value) };
}

function initMessage(): Extract<MainToWorkerMessage, { type: "init" }> {
  return {
    type: "init",
    value: {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      canvas: {} as OffscreenCanvas,
      wasmUrl: "/lume_core.wasm",
      entityCapacity: 8,
      resourceCapacity: 8,
      transformCapacity: 8,
      meshRendererCapacity: 8,
      cameraCapacity: 4,
      boundsCapacity: 8,
      size: { width: 1, height: 1, devicePixelRatio: 1 },
      renderer: {},
      geometryLimits: {
        decode: {
          maxEncodedBytes: 2_048,
          maxDecodedBytes: 256,
          maxVertices: 16,
          maxIndices: 48,
        },
        maxTemporaryBytes: 4_096,
        maxRetainedDecodedBytes: 512,
        maxResidentGpuBytes: 2_048,
      },
    },
  };
}

function createRenderer(
  lost: Promise<GPUDeviceLostInfo> = new Promise<GPUDeviceLostInfo>(() => undefined),
): MeshRenderer {
  return {
    lost,
    frameTimings: {
      bufferUploadCpuTimeMs: 0,
      renderPreparationCpuTimeMs: 0,
      commandEncodingCpuTimeMs: 0,
      queueSubmitCpuTimeMs: 0,
    },
    registerGeometry: vi.fn(),
    registerExternalGeometry: vi.fn(),
    removeGeometry: vi.fn(),
    registerBasicMaterial: vi.fn(),
    removeBasicMaterial: vi.fn(),
    execute: vi.fn(),
    resize: vi.fn(),
    stats: vi.fn(),
    dispose: vi.fn(),
  } satisfies MeshRenderer;
}

function createCore(): WasmCore {
  return {
    frameTimings: {
      systemsCpuTimeMs: 0,
      extractionCpuTimeMs: 0,
      visibilityCpuTimeMs: 0,
    },
    createBasicMaterial: vi.fn(),
    removeBasicMaterial: vi.fn(),
    apply: vi.fn(),
    updateSharedCommands: vi.fn(),
    updateSharedTransforms: vi.fn(),
    resize: vi.fn(),
    invalidateRendererCache: vi.fn(),
    update: vi.fn(),
    stats: vi.fn(),
    dispose: vi.fn(),
  } satisfies WasmCore;
}

function triangleGlb(): ArrayBuffer {
  const binary = new ArrayBuffer(80);
  const view = new DataView(binary);
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  const normals = [0, 0, 1, 0, 0, 1, 0, 0, 1];
  for (let index = 0; index < positions.length; index += 1) {
    view.setFloat32(index * 4, positions[index] ?? 0, true);
    view.setFloat32(36 + index * 4, normals[index] ?? 0, true);
  }
  view.setUint16(72, 0, true);
  view.setUint16(74, 1, true);
  view.setUint16(76, 2, true);
  const document = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: 78 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36, target: 34_962 },
      { buffer: 0, byteOffset: 36, byteLength: 36, target: 34_962 },
      { buffer: 0, byteOffset: 72, byteLength: 6, target: 34_963 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 2, componentType: 5123, count: 3, type: "SCALAR" },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, mode: 4 }] }],
  };
  const json = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = (json.byteLength + 3) & ~3;
  const totalLength = 12 + 8 + jsonLength + 8 + binary.byteLength;
  const glb = new ArrayBuffer(totalLength);
  const glbView = new DataView(glb);
  const bytes = new Uint8Array(glb);
  glbView.setUint32(0, 0x4654_6c67, true);
  glbView.setUint32(4, 2, true);
  glbView.setUint32(8, totalLength, true);
  glbView.setUint32(12, jsonLength, true);
  glbView.setUint32(16, 0x4e4f_534a, true);
  bytes.fill(0x20, 20, 20 + jsonLength);
  bytes.set(json, 20);
  const binaryHeader = 20 + jsonLength;
  glbView.setUint32(binaryHeader, binary.byteLength, true);
  glbView.setUint32(binaryHeader + 4, 0x004e_4942, true);
  bytes.set(new Uint8Array(binary), binaryHeader + 8);
  return glb;
}
