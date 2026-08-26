import {
  type MainToWorkerMessage,
  RUNTIME_PROTOCOL_VERSION,
  type WorkerToMainMessage,
} from "@lume/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleWorkerMessage } from "./engine/lifecycle.js";
import type { EngineState } from "./engine/state.js";
import { createEngine, GeometryLoadError, type GeometryLoadLimits } from "./index.js";
import { createResourceState } from "./resource-lifecycle.js";

const LIMITS: GeometryLoadLimits = {
  decode: {
    maxEncodedBytes: 256,
    maxDecodedBytes: 256,
    maxVertices: 16,
    maxIndices: 48,
  },
  maxTemporaryBytes: 1_024,
  maxRetainedDecodedBytes: 512,
  maxResidentGpuBytes: 2_048,
};

afterEach(() => vi.unstubAllGlobals());

describe("public geometry loading", () => {
  it("publishes a handle only after correlated readiness and follows normal mesh retirement", async () => {
    const harness = createWorkerHarness();
    const engine = await initializedEngine(harness, LIMITS);

    const loading = engine.load.geometry("models/triangle.glb");
    const request = requiredLoadMessage(harness.posted);
    expect(request.source).toBe("https://example.test/app/models/triangle.glb");
    expect(request.handle).toBe(3);

    let settled = false;
    void loading.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    harness.receive({
      type: "geometry-ready",
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      requestId: request.requestId,
      handle: request.handle,
      bounds: { min: [0, 0, 0], max: [1, 1, 0] },
    });
    const geometry = await loading;
    const mesh = engine.create.mesh({ geometry });
    engine.destroy(geometry);
    expect(() => engine.create.mesh({ geometry })).toThrow("retired");
    engine.destroy(mesh);

    expect(harness.posted).toContainEqual({
      type: "command",
      value: {
        type: "retire-resource",
        resourceKind: "geometry",
        handle: request.handle,
      },
    });
  });

  it("correlates out-of-order success and failure and mirrors consumed generations", async () => {
    const harness = createWorkerHarness();
    const engine = await initializedEngine(harness, LIMITS, 5);
    const first = engine.load.geometry("first.glb");
    const second = engine.load.geometry("second.glb");
    const requests = loadMessages(harness.posted);
    const firstRequest = requests[0];
    const secondRequest = requests[1];
    if (firstRequest === undefined || secondRequest === undefined) {
      throw new Error("Expected two geometry requests.");
    }

    harness.receive(failedMessage(secondRequest, "LUME_ASSET_FORMAT", "geometry"));
    harness.receive(readyMessage(firstRequest));

    await expect(second).rejects.toMatchObject({
      name: "GeometryLoadError",
      code: "LUME_ASSET_FORMAT",
      stage: "geometry",
    });
    await expect(first).resolves.toMatchObject({ kind: "geometry" });

    const third = engine.load.geometry("third.glb");
    const thirdRequest = loadMessages(harness.posted)[2];
    if (thirdRequest === undefined) throw new Error("Expected a third geometry request.");
    expect(thirdRequest.handle).toBe((1 << 20) | 4);
    harness.receive(readyMessage(thirdRequest));
    await expect(third).resolves.toMatchObject({ kind: "geometry" });
  });

  it("rejects an already-aborted signal before posting and waits for worker cleanup otherwise", async () => {
    const harness = createWorkerHarness();
    const engine = await initializedEngine(harness, LIMITS);
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const messageCount = harness.posted.length;

    await expect(
      engine.load.geometry("skipped.glb", { signal: alreadyAborted.signal }),
    ).rejects.toMatchObject({
      name: "AbortError",
      code: "LUME_ASSET_ABORTED",
    });
    expect(harness.posted).toHaveLength(messageCount);

    const controller = new AbortController();
    const loading = engine.load.geometry("cancelled.glb", { signal: controller.signal });
    const request = requiredLoadMessage(harness.posted);
    let rejected: unknown;
    void loading.catch((error: unknown) => {
      rejected = error;
    });
    controller.abort();
    await Promise.resolve();
    expect(rejected).toBeUndefined();
    expect(harness.posted.at(-1)).toEqual({
      type: "abort-geometry-load",
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      requestId: request.requestId,
      handle: request.handle,
    });

    harness.receive(failedMessage(request, "LUME_ASSET_ABORTED", "lifecycle"));
    await expect(loading).rejects.toMatchObject({
      name: "AbortError",
      code: "LUME_ASSET_ABORTED",
      stage: "lifecycle",
    });

    const completedController = new AbortController();
    const completed = engine.load.geometry("completed.glb", {
      signal: completedController.signal,
    });
    const completedRequest = requiredLoadMessage(harness.posted);
    expect(completedRequest.handle).toBe((1 << 20) | 3);
    harness.receive(readyMessage(completedRequest));
    await completed;
    const messagesAfterReady = harness.posted.length;
    completedController.abort();
    expect(harness.posted).toHaveLength(messagesAfterReady);
  });

  it("rejects pending loads on disposal and ignores late worker completion", async () => {
    const harness = createWorkerHarness();
    const engine = await initializedEngine(harness, LIMITS);
    const loading = engine.load.geometry("late.glb");
    const request = requiredLoadMessage(harness.posted);

    engine.dispose();
    await expect(loading).rejects.toMatchObject({
      name: "GeometryLoadError",
      code: "LUME_ASSET_ABORTED",
      stage: "lifecycle",
    });
    harness.receive(readyMessage(request));
    expect(engine.status).toBe("disposed");
  });

  it("rejects invalid lifecycle, absent budgets, and corrupt response correlation", async () => {
    const unconfiguredHarness = createWorkerHarness();
    const unconfigured = createEngine(testCanvas(), {
      autoResize: false,
      workerFactory: () => unconfiguredHarness.worker,
    });
    await expect(unconfigured.load.geometry("before-init.glb")).rejects.toBeInstanceOf(
      GeometryLoadError,
    );
    await expect(unconfigured.load.geometry("before-init.glb")).rejects.toMatchObject({
      name: "GeometryLoadError",
      code: "LUME_ASSET_ABORTED",
      stage: "lifecycle",
    });
    await initialize(unconfiguredHarness, unconfigured, undefined);
    await expect(unconfigured.load.geometry("disabled.glb")).rejects.toMatchObject({
      code: "LUME_ASSET_BUDGET_EXCEEDED",
      stage: "budget",
    });

    const onError = vi.fn();
    const harness = createWorkerHarness();
    const engine = await initializedEngine(harness, LIMITS, 4, onError);
    const lifecycleFailure = engine.load.geometry("worker-lifecycle.glb");
    const lifecycleRequest = requiredLoadMessage(harness.posted);
    harness.receive(failedMessage(lifecycleRequest, "LUME_ASSET_ABORTED", "lifecycle"));
    await expect(lifecycleFailure).rejects.toMatchObject({
      name: "GeometryLoadError",
      code: "LUME_ASSET_ABORTED",
      stage: "lifecycle",
    });

    const loading = engine.load.geometry("corrupt.glb");
    const request = requiredLoadMessage(harness.posted);
    harness.receive({ ...readyMessage(request), handle: request.handle + 1 });

    await expect(loading).rejects.toMatchObject({
      name: "GeometryLoadError",
      code: "LUME_ASSET_ABORTED",
    });
    expect(engine.status).toBe("failed");
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Geometry load response violated protocol correlation." }),
    );
  });

  it("validates explicit geometry budgets before creating worker resources", () => {
    const workerFactory = vi.fn();
    expect(() =>
      createEngine(testCanvas(), {
        autoResize: false,
        workerFactory,
        geometryLimits: {
          ...LIMITS,
          maxTemporaryBytes: 0,
        },
      }),
    ).toThrow("maxTemporaryBytes");
    expect(workerFactory).not.toHaveBeenCalled();
  });

  it("rejects the triggering promise when ready-handle publication fails", () => {
    const reject = vi.fn();
    const onError = vi.fn();
    const postMessage = vi.fn();
    const handle = Object.freeze({ kind: "geometry" as const });
    const state = {
      status: "ready",
      runningIntent: false,
      lifecycleEpoch: 0,
      config: { onError },
      worker: { postMessage },
      resources: createResourceState(4, 1),
      geometryLoads: new Map([
        [
          17,
          {
            handle,
            raw: 1,
            resolve: vi.fn(),
            reject,
            removeAbortListener: vi.fn(),
            abortRequested: false,
          },
        ],
      ]),
      statsRequests: new Map(),
      resolveInit: undefined,
      rejectInit: undefined,
    } as unknown as EngineState;

    handleWorkerMessage(state, {
      type: "geometry-ready",
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      requestId: 17,
      handle: 1,
      bounds: { min: [0, 0, 0], max: [1, 1, 0] },
    });

    expect(state.status).toBe("failed");
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Geometry load reservation is stale or no longer pending.",
      }),
    );
    expect(reject).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({ type: "dispose" });
  });
});

async function initializedEngine(
  harness: WorkerHarness,
  geometryLimits: GeometryLoadLimits,
  resourceCapacity = 4,
  onError?: (error: Error) => void,
) {
  const engine = createEngine(testCanvas(), {
    autoResize: false,
    resourceCapacity,
    geometryLimits,
    workerFactory: () => harness.worker,
    ...(onError === undefined ? {} : { onError }),
  });
  await initialize(harness, engine, geometryLimits);
  return engine;
}

async function initialize(
  harness: WorkerHarness,
  engine: ReturnType<typeof createEngine>,
  expectedLimits: GeometryLoadLimits | undefined,
) {
  const initializing = engine.init();
  const init = harness.posted.find(
    (message): message is Extract<MainToWorkerMessage, { type: "init" }> => message.type === "init",
  );
  expect(init?.value.geometryLimits).toEqual(expectedLimits);
  harness.receive({ type: "ready" });
  await initializing;
}

interface WorkerHarness {
  readonly worker: Worker;
  readonly posted: MainToWorkerMessage[];
  receive(message: WorkerToMainMessage): void;
}

function createWorkerHarness(): WorkerHarness {
  const posted: MainToWorkerMessage[] = [];
  let onMessage: ((event: MessageEvent<WorkerToMainMessage>) => void) | undefined;
  const worker = {
    addEventListener(type: string, listener: EventListener) {
      if (type === "message") {
        onMessage = listener as (event: MessageEvent<WorkerToMainMessage>) => void;
      }
    },
    postMessage(message: MainToWorkerMessage) {
      posted.push(message);
    },
    terminate: vi.fn(),
  } as unknown as Worker;
  return {
    worker,
    posted,
    receive(message) {
      onMessage?.({ data: message } as MessageEvent<WorkerToMainMessage>);
    },
  };
}

function testCanvas(): HTMLCanvasElement {
  vi.stubGlobal("document", { baseURI: "https://example.test/app/" });
  vi.stubGlobal("window", { devicePixelRatio: 1 });
  vi.stubGlobal("crossOriginIsolated", false);
  return {
    getBoundingClientRect: () => ({ width: 640, height: 360 }),
    transferControlToOffscreen: () => ({}) as OffscreenCanvas,
  } as HTMLCanvasElement;
}

function loadMessages(
  messages: readonly MainToWorkerMessage[],
): Array<Extract<MainToWorkerMessage, { type: "load-geometry" }>> {
  return messages.filter(
    (message): message is Extract<MainToWorkerMessage, { type: "load-geometry" }> =>
      message.type === "load-geometry",
  );
}

function requiredLoadMessage(
  messages: readonly MainToWorkerMessage[],
): Extract<MainToWorkerMessage, { type: "load-geometry" }> {
  const request = loadMessages(messages).at(-1);
  if (request === undefined) throw new Error("Expected a geometry load request.");
  return request;
}

function readyMessage(
  request: Extract<MainToWorkerMessage, { type: "load-geometry" }>,
): Extract<WorkerToMainMessage, { type: "geometry-ready" }> {
  return {
    type: "geometry-ready",
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    requestId: request.requestId,
    handle: request.handle,
    bounds: { min: [0, 0, 0], max: [1, 1, 0] },
  };
}

function failedMessage(
  request: Extract<MainToWorkerMessage, { type: "load-geometry" }>,
  code: Extract<WorkerToMainMessage, { type: "geometry-failed" }>["error"]["code"],
  stage: Extract<WorkerToMainMessage, { type: "geometry-failed" }>["error"]["stage"],
): Extract<WorkerToMainMessage, { type: "geometry-failed" }> {
  return {
    type: "geometry-failed",
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    requestId: request.requestId,
    handle: request.handle,
    error: { code, stage, message: "fixture failure" },
  };
}
