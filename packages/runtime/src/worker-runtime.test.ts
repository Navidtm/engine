import type { MeshRenderer } from "@lume/renderer";
import { describe, expect, it, vi } from "vitest";

import {
  type MainToWorkerMessage,
  RUNTIME_PROTOCOL_VERSION,
  type WorkerToMainMessage,
} from "./protocol.js";
import type { WasmCore } from "./wasm.js";

const mocks = vi.hoisted(() => ({
  createMeshRenderer: vi.fn(),
  createWasmCore: vi.fn(),
}));

vi.mock("@lume/renderer", () => ({ createMeshRenderer: mocks.createMeshRenderer }));
vi.mock("./wasm.js", () => ({ createWasmCore: mocks.createWasmCore }));

import { createWorkerRuntime, type WorkerHost } from "./worker-runtime.js";

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
});
