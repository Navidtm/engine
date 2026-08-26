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
          maxEncodedBytes: 256,
          maxDecodedBytes: 256,
          maxVertices: 16,
          maxIndices: 48,
        },
        maxTemporaryBytes: 512,
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
