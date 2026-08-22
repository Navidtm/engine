import type { MeshRenderer, SurfaceSize } from "@lume/renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const SEEDS = [0x0246_8ace, 0x1357_9bdf, 0x5eed_c0de, 0xdead_beef] as const;

beforeEach(() => {
  mocks.createMeshRenderer.mockReset();
  mocks.createWasmCore.mockReset();
});

describe("seeded worker lifecycle state machine", () => {
  for (const seed of selectedSeeds()) {
    it(`preserves lifecycle state across long transitions (seed=${seed})`, async () => {
      await runLifecycleSeed(seed);
    });

    it(`cleans up either late initialization sibling (seed=${seed})`, async () => {
      await runInitializationFailureSeed(seed);
    });
  }
});

async function runLifecycleSeed(seed: number): Promise<void> {
  const random = createRandom(seed);
  const rendererResult = deferred<MeshRenderer>();
  const coreResult = deferred<WasmCore>();
  const deviceLoss = deferred<GPUDeviceLostInfo>();
  const renderer = createRenderer(deviceLoss.promise);
  const replacement = createRenderer(new Promise<GPUDeviceLostInfo>(() => undefined));
  const core = createCore();
  mocks.createMeshRenderer.mockReturnValueOnce(rendererResult.promise);
  mocks.createMeshRenderer.mockResolvedValueOnce(replacement);
  mocks.createWasmCore.mockReturnValueOnce(coreResult.promise);
  const harness = createHostHarness();
  const receive = createWorkerRuntime(harness.host);
  let step = "initialization";

  try {
    receive(initMessage());
    const initializationSizes = Array.from({ length: 4 }, () => generatedSize(random));
    for (const size of initializationSizes) receive({ type: "resize", value: size });
    const latestInitializationSize = initializationSizes.at(-1);
    if (latestInitializationSize === undefined) throw new Error("Missing generated resize.");

    if ((random() & 1) === 0) {
      coreResult.resolve(core);
      await Promise.resolve();
      rendererResult.resolve(renderer);
    } else {
      rendererResult.resolve(renderer);
      await Promise.resolve();
      coreResult.resolve(core);
    }
    await vi.waitFor(() => expect(harness.posted).toContainEqual({ type: "ready" }));
    expect(core.resize).toHaveBeenCalledWith(
      latestInitializationSize.width / Math.max(latestInitializationSize.height, 1),
    );
    expect(renderer.resize).toHaveBeenCalledWith(latestInitializationSize);

    step = "start-stop-restart";
    receive({ type: "start", lifecycleEpoch: 1 });
    receive({ type: "start", lifecycleEpoch: 1 });
    expect(core.update).toHaveBeenCalledTimes(1);
    const firstFrame = harness.latestFrame();

    receive({ type: "stop", lifecycleEpoch: 2 });
    receive({ type: "stop", lifecycleEpoch: 2 });
    expect(harness.posted).toContainEqual({ type: "stopped", lifecycleEpoch: 2 });
    firstFrame?.(16);
    expect(core.update).toHaveBeenCalledTimes(1);

    receive({ type: "start", lifecycleEpoch: 3 });
    const secondFrame = harness.latestFrame();
    expect(core.update).toHaveBeenCalledTimes(2);
    secondFrame?.(32);
    expect(core.update).toHaveBeenCalledTimes(3);

    step = "ready-resize";
    const runningSize = generatedSize(random);
    receive({ type: "resize", value: runningSize });
    expect(core.resize).toHaveBeenLastCalledWith(
      runningSize.width / Math.max(runningSize.height, 1),
    );
    expect(renderer.resize).toHaveBeenLastCalledWith(runningSize);

    step = "device-loss";
    const staleFrame = harness.latestFrame();
    const updatesBeforeRecovery = vi.mocked(core.update).mock.calls.length;
    deviceLoss.resolve({
      reason: "unknown",
      message: `seeded loss ${seed}`,
    } as GPUDeviceLostInfo);
    await vi.waitFor(() => expect(core.invalidateRendererCache).toHaveBeenCalledTimes(1));
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(vi.mocked(core.update).mock.calls.length).toBeGreaterThan(updatesBeforeRecovery),
    );
    expect(harness.posted.some((message) => message.type === "error")).toBe(false);
    const updatesAfterRecovery = vi.mocked(core.update).mock.calls.length;
    staleFrame?.(48);
    expect(core.update).toHaveBeenCalledTimes(updatesAfterRecovery);

    step = "idempotent-disposal";
    receive({ type: "dispose" });
    receive({ type: "dispose" });
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
    expect(replacement.dispose).toHaveBeenCalledTimes(1);
    expect(core.dispose).toHaveBeenCalledTimes(1);
    expect(harness.posted.filter((message) => message.type === "disposed")).toHaveLength(1);
  } catch (cause) {
    throw new Error(`Worker lifecycle state machine failed (seed=${seed}, step=${step}).`, {
      cause,
    });
  }
}

async function runInitializationFailureSeed(seed: number): Promise<void> {
  const rendererResult = deferred<MeshRenderer>();
  const coreResult = deferred<WasmCore>();
  const renderer = createRenderer(new Promise<GPUDeviceLostInfo>(() => undefined));
  const core = createCore();
  mocks.createMeshRenderer.mockReturnValueOnce(rendererResult.promise);
  mocks.createWasmCore.mockReturnValueOnce(coreResult.promise);
  const harness = createHostHarness();
  const receive = createWorkerRuntime(harness.host);
  const rendererFails = (seed & 1) === 0;

  receive(initMessage());
  receive({ type: "resize", value: generatedSize(createRandom(seed)) });
  if (rendererFails) {
    rendererResult.reject(new Error(`renderer failed ${seed}`));
    await Promise.resolve();
    coreResult.resolve(core);
  } else {
    coreResult.reject(new Error(`core failed ${seed}`));
    await Promise.resolve();
    rendererResult.resolve(renderer);
  }

  await vi.waitFor(() =>
    expect(harness.posted.some((message) => message.type === "error")).toBe(true),
  );
  expect(harness.posted.some((message) => message.type === "ready")).toBe(false);
  expect(renderer.dispose).toHaveBeenCalledTimes(rendererFails ? 0 : 1);
  expect(core.dispose).toHaveBeenCalledTimes(rendererFails ? 1 : 0);
}

function createHostHarness(): {
  readonly host: WorkerHost;
  readonly posted: WorkerToMainMessage[];
  readonly frames: Map<number, FrameRequestCallback>;
  readonly latestFrame: () => FrameRequestCallback | undefined;
} {
  const posted: WorkerToMainMessage[] = [];
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  return {
    posted,
    frames,
    latestFrame: () => frames.get(nextFrame - 1),
    host: {
      postMessage: (message) => posted.push(message),
      requestAnimationFrame: vi.fn((callback) => {
        const frame = nextFrame++;
        frames.set(frame, callback);
        return frame;
      }),
      cancelAnimationFrame: vi.fn(),
    },
  };
}

function createRenderer(lost: Promise<GPUDeviceLostInfo>): MeshRenderer {
  return {
    lost,
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
      meshRendererCapacity: 16,
      cameraCapacity: 8,
      boundsCapacity: 16,
      size: { width: 640, height: 360, devicePixelRatio: 1 },
      renderer: {},
    },
  };
}

function generatedSize(random: () => number): SurfaceSize {
  return {
    width: 320 + (random() % 1_601),
    height: 180 + (random() % 901),
    devicePixelRatio: 1 + (random() % 3) * 0.5,
  };
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

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function selectedSeeds(): readonly number[] {
  const configured = process.env.LUME_TEST_SEED;
  if (configured === undefined) return SEEDS;
  const seed = Number(configured);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error("LUME_TEST_SEED must be an unsigned 32-bit integer.");
  }
  return [seed];
}
