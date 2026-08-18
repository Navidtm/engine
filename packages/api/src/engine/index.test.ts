import type { MainToWorkerMessage, WorkerToMainMessage } from "@lume/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createEngine } from "./index.js";

afterEach(() => vi.unstubAllGlobals());

describe("high-level engine API", () => {
  it("rejects structural command budgets outside the entity budget", () => {
    const canvas = {} as HTMLCanvasElement;
    expect(() =>
      createEngine(canvas, {
        entityCapacity: 4,
        transport: { structuralCommandCapacity: 5 },
        workerFactory: () => ({}) as Worker,
      }),
    ).toThrow("transport.structuralCommandCapacity");
  });

  it("rejects transform capacity beyond the entity budget", () => {
    expect(() =>
      createEngine({} as HTMLCanvasElement, {
        entityCapacity: 4,
        transport: { transformCapacity: 5 },
        workerFactory: () => ({}) as Worker,
      }),
    ).toThrow("transport.transformCapacity");
  });

  it("validates engine camera configuration before creating a worker", () => {
    const workerFactory = vi.fn(() => ({}) as Worker);
    expect(() =>
      createEngine({} as HTMLCanvasElement, {
        camera: { near: 10, far: 1 },
        workerFactory,
      }),
    ).toThrow("Camera far");
    expect(workerFactory).not.toHaveBeenCalled();
  });

  it("rejects foreign material handles and invalid options before allocating an entity", () => {
    const canvas = {} as HTMLCanvasElement;
    const workerFactory = () =>
      ({
        addEventListener: vi.fn(),
        postMessage: vi.fn(),
        terminate: vi.fn(),
      }) as unknown as Worker;
    const first = createEngine(canvas, { autoResize: false, workerFactory });
    const second = createEngine(canvas, { autoResize: false, workerFactory });
    const foreignMaterial = first.create.basicMaterial();

    expect(() => second.create.mesh({ geometry: "cube", material: foreignMaterial })).toThrow(
      "does not belong",
    );
    expect(() => second.create.mesh({ geometry: "cube", position: [Number.NaN, 0, 0] })).toThrow(
      "position",
    );
    expect(second.world.createEntity()).toMatchObject({ index: 1, generation: 0 });
  });

  it("creates a scene without exposing ECS commands", async () => {
    let onMessage: ((event: MessageEvent<WorkerToMainMessage>) => void) | undefined;
    const posted: MainToWorkerMessage[] = [];
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
    const canvas = {
      getBoundingClientRect: () => ({ width: 640, height: 360 }),
      transferControlToOffscreen: () => ({}) as OffscreenCanvas,
    } as HTMLCanvasElement;
    vi.stubGlobal("document", { baseURI: "https://example.test/" });
    vi.stubGlobal("window", { devicePixelRatio: 2 });
    vi.stubGlobal("crossOriginIsolated", true);

    const engine = createEngine(canvas, {
      autoResize: false,
      workerFactory: () => worker,
      wasmUrl: "assets/lume_core.wasm",
      powerPreference: "high",
    });
    const blue = engine.create.basicMaterial({ color: [0.2, 0.4, 1, 1] });
    const cube = engine.create.mesh({ geometry: "cube", material: blue, position: [0, 0, -5] });

    expect(cube.kind).toBe("mesh");
    expect(engine.camera.position.z).toBe(3);
    const initialization = engine.init();
    expect(posted[0]?.type).toBe("init");
    if (posted[0]?.type === "init") {
      expect(posted[0].value.wasmUrl).toBe("https://example.test/assets/lume_core.wasm");
      expect(posted[0].value.renderer.powerPreference).toBe("high-performance");
      expect(posted[0].value.entityCapacity).toBe(4_097);
      expect(posted[0].value.transformCapacity).toBe(4_097);
    }
    onMessage?.({ data: { type: "ready" } } as MessageEvent<WorkerToMainMessage>);
    await initialization;

    const batch = posted[1];
    expect(batch?.type).toBe("batch");
    if (batch?.type === "batch") {
      expect(batch.value.map((command) => command.type)).toEqual([
        "spawn",
        "add-transform",
        "add-camera",
        "spawn",
        "add-material",
        "spawn",
        "add-transform",
        "add-mesh",
      ]);
    }
    const messagesBeforeTransform = posted.length;
    cube.position.set(1, 2, -6);
    expect(cube.position.z).toBe(-6);
    expect(posted).toHaveLength(messagesBeforeTransform);
    const initializationMessage = posted[0];
    expect(
      initializationMessage?.type === "init" ? initializationMessage.value.sharedMemory : undefined,
    ).toBeInstanceOf(SharedArrayBuffer);

    engine.destroy(cube);
    const recycled = engine.world.createEntity();
    expect(recycled).toEqual({ index: cube.id.index, generation: cube.id.generation + 1 });
    expect(() => cube.position.set(0, 0, 0)).toThrow("Entity handle is stale");
    expect(() => engine.world.destroyEntity(cube.id)).toThrow("Entity handle is stale");
  });

  it("uses the package-owned WASM artifact by default", async () => {
    const posted: MainToWorkerMessage[] = [];
    const worker = {
      addEventListener: vi.fn(),
      postMessage(message: MainToWorkerMessage) {
        posted.push(message);
      },
      terminate: vi.fn(),
    } as unknown as Worker;
    const canvas = {
      getBoundingClientRect: () => ({ width: 1, height: 1 }),
      transferControlToOffscreen: () => ({}) as OffscreenCanvas,
    } as HTMLCanvasElement;
    vi.stubGlobal("window", { devicePixelRatio: 1 });
    vi.stubGlobal("crossOriginIsolated", false);

    const engine = createEngine(canvas, { autoResize: false, workerFactory: () => worker });
    const initialization = engine.init();

    const message = posted[0];
    expect(message?.type).toBe("init");
    if (message?.type === "init") {
      expect(new URL(message.value.wasmUrl).pathname).toMatch(/\/lume_core\.wasm$/);
      expect(message.value.wasmUrl).not.toContain("/public/");
    }
    engine.dispose();
    await expect(initialization).rejects.toThrow("disposed during initialization");
  });

  it("correlates lifecycle acknowledgements and publishes idempotent controls", async () => {
    let onMessage: ((event: MessageEvent<WorkerToMainMessage>) => void) | undefined;
    const posted: MainToWorkerMessage[] = [];
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
    const canvas = {
      getBoundingClientRect: () => ({ width: 640, height: 360 }),
      transferControlToOffscreen: () => ({}) as OffscreenCanvas,
    } as HTMLCanvasElement;
    vi.stubGlobal("document", { baseURI: "https://example.test/" });
    vi.stubGlobal("window", { devicePixelRatio: 1 });
    vi.stubGlobal("crossOriginIsolated", false);
    const engine = createEngine(canvas, {
      autoResize: false,
      workerFactory: () => worker,
      wasmUrl: "https://example.test/lume_core.wasm",
    });

    const initialization = engine.init();
    onMessage?.({ data: { type: "ready" } } as MessageEvent<WorkerToMainMessage>);
    await initialization;
    posted.length = 0;

    engine.start();
    engine.start();
    expect(posted).toEqual([{ type: "start", lifecycleEpoch: 1 }]);

    engine.stop();
    expect(engine.status).toBe("running");
    engine.start();
    expect(posted).toEqual([
      { type: "start", lifecycleEpoch: 1 },
      { type: "stop", lifecycleEpoch: 2 },
      { type: "start", lifecycleEpoch: 3 },
    ]);

    onMessage?.({
      data: { type: "stopped", lifecycleEpoch: 2 },
    } as unknown as MessageEvent<WorkerToMainMessage>);
    expect(engine.status).toBe("running");

    engine.stop();
    engine.stop();
    expect(posted).toHaveLength(4);
    onMessage?.({
      data: { type: "stopped", lifecycleEpoch: 4 },
    } as unknown as MessageEvent<WorkerToMainMessage>);
    expect(engine.status).toBe("stopped");

    engine.dispose();
    onMessage?.({
      data: { type: "stopped", lifecycleEpoch: 4 },
    } as unknown as MessageEvent<WorkerToMainMessage>);
    onMessage?.({ data: { type: "ready" } } as MessageEvent<WorkerToMainMessage>);
    expect(engine.status).toBe("disposed");
  });
});
