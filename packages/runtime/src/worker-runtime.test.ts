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

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return {
    promise,
    resolve: (value) => resolve?.(value),
    reject: (reason) => reject?.(reason),
  };
}

function initMessage(): MainToWorkerMessage {
  return {
    type: "init",
    value: {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      canvas: {} as OffscreenCanvas,
      wasmUrl: "/lume_core.wasm",
      entityCapacity: 16,
      resourceCapacity: 16,
      transformCapacity: 16,
      size: { width: 640, height: 360, devicePixelRatio: 1 },
      renderer: {},
    },
  };
}

describe("worker runtime resource ownership", () => {
  it("waits for both initialization branches and disposes a late success", async () => {
    const rendererResult = deferred<MeshRenderer>();
    const coreResult = deferred<WasmCore>();
    const renderer = {
      lost: new Promise<GPUDeviceLostInfo>(() => undefined),
      frameTimings: {
        bufferUploadCpuTimeMs: 0,
        renderPreparationCpuTimeMs: 0,
        commandEncodingCpuTimeMs: 0,
        queueSubmitCpuTimeMs: 0,
      },
      registerGeometry: vi.fn(),
      removeGeometry: vi.fn(),
      registerBasicMaterial: vi.fn(),
      removeBasicMaterial: vi.fn(),
      execute: vi.fn(),
      resize: vi.fn(),
      stats: vi.fn(),
      dispose: vi.fn(),
    } satisfies MeshRenderer;
    mocks.createMeshRenderer.mockReturnValueOnce(rendererResult.promise);
    mocks.createWasmCore.mockReturnValueOnce(coreResult.promise);
    const posted: WorkerToMainMessage[] = [];
    const host: WorkerHost = {
      postMessage: (message) => posted.push(message),
      requestAnimationFrame: vi.fn(() => 1),
      cancelAnimationFrame: vi.fn(),
    };
    const receive = createWorkerRuntime(host);

    receive(initMessage());
    coreResult.reject(new Error("WASM failed"));
    await Promise.resolve();
    expect(posted).toEqual([]);

    rendererResult.resolve(renderer);
    await vi.waitFor(() => expect(posted[0]?.type).toBe("error"));
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
    expect(posted[0]).toMatchObject({ type: "error", message: "WASM failed" });
  });

  it("rejects a second init while the first init is pending", async () => {
    const rendererResult = deferred<MeshRenderer>();
    const coreResult = deferred<WasmCore>();
    mocks.createMeshRenderer.mockReturnValueOnce(rendererResult.promise);
    mocks.createWasmCore.mockReturnValueOnce(coreResult.promise);
    const posted: WorkerToMainMessage[] = [];
    const host: WorkerHost = {
      postMessage: (message) => posted.push(message),
      requestAnimationFrame: vi.fn(() => 1),
      cancelAnimationFrame: vi.fn(),
    };
    const receive = createWorkerRuntime(host);

    receive(initMessage());
    receive(initMessage());

    expect(posted[0]).toMatchObject({
      type: "error",
      message: "Runtime is already initializing or initialized.",
    });
    receive({ type: "dispose" });
    rendererResult.reject(new Error("disposed"));
    coreResult.reject(new Error("disposed"));
    await Promise.allSettled([rendererResult.promise, coreResult.promise]);
  });

  it("flushes shared state before ordered fallback commands but not initialization batches", async () => {
    const order: string[] = [];
    const renderer = {
      lost: new Promise<GPUDeviceLostInfo>(() => undefined),
      frameTimings: {
        bufferUploadCpuTimeMs: 0,
        renderPreparationCpuTimeMs: 0,
        commandEncodingCpuTimeMs: 0,
        queueSubmitCpuTimeMs: 0,
      },
      registerGeometry: vi.fn(),
      removeGeometry: vi.fn(),
      registerBasicMaterial: vi.fn(),
      removeBasicMaterial: vi.fn(),
      execute: vi.fn(),
      resize: vi.fn(),
      stats: vi.fn(),
      dispose: vi.fn(),
    } satisfies MeshRenderer;
    const core = {
      frameTimings: {
        systemsCpuTimeMs: 0,
        extractionCpuTimeMs: 0,
        visibilityCpuTimeMs: 0,
      },
      createBasicMaterial: vi.fn(),
      removeBasicMaterial: vi.fn(),
      apply: vi.fn((command: { readonly type: string }) => order.push(`apply:${command.type}`)),
      updateSharedCommands: vi.fn(() => order.push("shared-commands")),
      updateSharedTransforms: vi.fn(() => order.push("shared-transforms")),
      resize: vi.fn(),
      update: vi.fn(),
      stats: vi.fn(),
      dispose: vi.fn(),
    } satisfies WasmCore;
    mocks.createMeshRenderer.mockResolvedValueOnce(renderer);
    mocks.createWasmCore.mockResolvedValueOnce(core);
    const posted: WorkerToMainMessage[] = [];
    const host: WorkerHost = {
      postMessage: (message) => posted.push(message),
      requestAnimationFrame: vi.fn(() => 1),
      cancelAnimationFrame: vi.fn(),
    };
    const receive = createWorkerRuntime(host);

    receive(initMessage());
    await vi.waitFor(() => expect(posted[0]?.type).toBe("ready"));
    receive({ type: "command", value: { type: "spawn", entity: 1 } });
    expect(order).toEqual(["shared-commands", "shared-transforms", "apply:spawn"]);

    order.length = 0;
    receive({
      type: "batch",
      value: [
        { type: "spawn", entity: 2 },
        { type: "despawn", entity: 2 },
      ],
    });
    expect(order).toEqual(["apply:spawn", "apply:despawn"]);
  });

  it("rejects stale scheduler callbacks across stop, restart, and disposal", async () => {
    const renderer = {
      lost: new Promise<GPUDeviceLostInfo>(() => undefined),
      frameTimings: {
        bufferUploadCpuTimeMs: 0,
        renderPreparationCpuTimeMs: 0,
        commandEncodingCpuTimeMs: 0,
        queueSubmitCpuTimeMs: 0,
      },
      registerGeometry: vi.fn(),
      removeGeometry: vi.fn(),
      registerBasicMaterial: vi.fn(),
      removeBasicMaterial: vi.fn(),
      execute: vi.fn(),
      resize: vi.fn(),
      stats: vi.fn(),
      dispose: vi.fn(),
    } satisfies MeshRenderer;
    const core = {
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
      update: vi.fn(),
      stats: vi.fn(),
      dispose: vi.fn(),
    } satisfies WasmCore;
    mocks.createMeshRenderer.mockResolvedValueOnce(renderer);
    mocks.createWasmCore.mockResolvedValueOnce(core);
    const posted: WorkerToMainMessage[] = [];
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextFrameRequest = 1;
    const host: WorkerHost = {
      postMessage: (message) => posted.push(message),
      requestAnimationFrame: vi.fn((callback) => {
        const request = nextFrameRequest;
        nextFrameRequest += 1;
        callbacks.set(request, callback);
        return request;
      }),
      cancelAnimationFrame: vi.fn(),
    };
    const receive = createWorkerRuntime(host);

    receive(initMessage());
    await vi.waitFor(() => expect(posted[0]?.type).toBe("ready"));
    receive({ type: "start", lifecycleEpoch: 1 });
    expect(core.update).toHaveBeenCalledTimes(1);
    expect(host.requestAnimationFrame).toHaveBeenCalledTimes(1);

    receive({ type: "stop", lifecycleEpoch: 2 });
    receive({ type: "start", lifecycleEpoch: 3 });
    expect(posted).toContainEqual({ type: "stopped", lifecycleEpoch: 2 });
    expect(core.update).toHaveBeenCalledTimes(2);
    expect(host.requestAnimationFrame).toHaveBeenCalledTimes(2);

    callbacks.get(1)?.(16);
    expect(core.update).toHaveBeenCalledTimes(2);
    expect(host.requestAnimationFrame).toHaveBeenCalledTimes(2);

    callbacks.get(2)?.(32);
    expect(core.update).toHaveBeenCalledTimes(3);
    expect(host.requestAnimationFrame).toHaveBeenCalledTimes(3);
    expect(callbacks.get(3)).toBe(callbacks.get(2));

    receive({ type: "start", lifecycleEpoch: 3 });
    expect(core.update).toHaveBeenCalledTimes(3);
    expect(host.requestAnimationFrame).toHaveBeenCalledTimes(3);

    receive({ type: "dispose" });
    callbacks.get(3)?.(48);
    expect(core.update).toHaveBeenCalledTimes(3);
    expect(host.requestAnimationFrame).toHaveBeenCalledTimes(3);
  });

  it("samples split timings only after a stats pull and accumulates completed samples", async () => {
    const renderer = {
      lost: new Promise<GPUDeviceLostInfo>(() => undefined),
      frameTimings: {
        bufferUploadCpuTimeMs: 4,
        renderPreparationCpuTimeMs: 5,
        commandEncodingCpuTimeMs: 6,
        queueSubmitCpuTimeMs: 7,
      },
      registerGeometry: vi.fn(),
      removeGeometry: vi.fn(),
      registerBasicMaterial: vi.fn(),
      removeBasicMaterial: vi.fn(),
      execute: vi.fn(),
      resize: vi.fn(),
      stats: vi.fn(() => ({
        gpuBufferBytes: 0,
        drawCalls: 0,
        submittedInstances: 0,
        bufferUploadCpuTimeMs: 0,
        bufferUploadBytes: 0,
        bufferWriteCount: 0,
        framePreparationCpuTimeMs: 0,
        gpuTimeMs: null,
        browserObjectsPerFrame: 0,
      })),
      dispose: vi.fn(),
    } satisfies MeshRenderer;
    const core = {
      frameTimings: {
        systemsCpuTimeMs: 1,
        extractionCpuTimeMs: 2,
        visibilityCpuTimeMs: 3,
      },
      createBasicMaterial: vi.fn(),
      removeBasicMaterial: vi.fn(),
      apply: vi.fn(),
      updateSharedCommands: vi.fn(),
      updateSharedTransforms: vi.fn(),
      resize: vi.fn(),
      update: vi.fn(() => ({}) as never),
      stats: vi.fn(() => ({
        entities: 0,
        renderInstances: 0,
        visibleObjects: 0,
        sharedTransformUpdates: 0,
        dirtyRanges: 0,
        bytesUploaded: 0,
        wasmHeapBytes: 0,
      })),
      dispose: vi.fn(),
    } satisfies WasmCore;
    mocks.createMeshRenderer.mockResolvedValueOnce(renderer);
    mocks.createWasmCore.mockResolvedValueOnce(core);
    const posted: WorkerToMainMessage[] = [];
    const callbacks: FrameRequestCallback[] = [];
    const host: WorkerHost = {
      postMessage: (message) => posted.push(message),
      requestAnimationFrame: vi.fn((callback) => {
        callbacks.push(callback);
        return callbacks.length;
      }),
      cancelAnimationFrame: vi.fn(),
    };
    const receive = createWorkerRuntime(host);

    receive(initMessage());
    await vi.waitFor(() => expect(posted[0]?.type).toBe("ready"));
    receive({ type: "start", lifecycleEpoch: 1 });
    expect(core.update).toHaveBeenLastCalledWith(false);

    receive({ type: "get-stats", requestId: 1 });
    const initial = posted.find(
      (message): message is Extract<WorkerToMainMessage, { type: "stats" }> =>
        message.type === "stats" && message.requestId === 1,
    );
    expect(initial?.value.timings.cpuStages.sampleCount).toBe(0);

    callbacks[0]?.(16);
    expect(core.update).toHaveBeenLastCalledWith(true);
    expect(renderer.execute).toHaveBeenLastCalledWith({}, true);
    expect(posted.filter((message) => message.type === "stats")).toHaveLength(1);

    receive({ type: "get-stats", requestId: 2 });
    const sampled = posted.find(
      (message): message is Extract<WorkerToMainMessage, { type: "stats" }> =>
        message.type === "stats" && message.requestId === 2,
    );
    expect(sampled?.value.timings.cpuStages).toMatchObject({
      sampleCount: 1,
      latest: {
        systems: 1,
        extraction: 2,
        visibility: 3,
        bufferUpload: 4,
        renderPreparation: 5,
        commandEncoding: 6,
        queueSubmit: 7,
      },
      cumulative: {
        systems: 1,
        extraction: 2,
        visibility: 3,
        bufferUpload: 4,
        renderPreparation: 5,
        commandEncoding: 6,
        queueSubmit: 7,
      },
    });
  });
});
