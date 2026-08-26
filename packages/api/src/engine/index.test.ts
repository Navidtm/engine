import type { MainToWorkerMessage, WorkerToMainMessage } from "@lume/runtime";
import { camera, type GeometryHandle, mesh as meshComponent } from "@lume/scene";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EngineCapacityError } from "../capacity.js";
import { createEngine } from "./index.js";

afterEach(() => vi.unstubAllGlobals());

describe("high-level engine API", () => {
  it("exposes effective application capacities without reserved engine slots", () => {
    const engine = createEngine({} as HTMLCanvasElement, {
      autoResize: false,
      entityCapacity: 4,
      resourceCapacity: 3,
      componentCapacities: { transforms: 2, meshRenderers: 1, cameras: 1, bounds: 1 },
      workerFactory: () =>
        ({
          addEventListener: vi.fn(),
          postMessage: vi.fn(),
          terminate: vi.fn(),
        }) as unknown as Worker,
    });

    expect(engine.capacities).toEqual({
      entities: 4,
      transforms: 2,
      meshRenderers: 1,
      cameras: 1,
      materials: 3,
      geometries: 3,
      bounds: 1,
      renderInstances: 4,
      renderCameras: 1,
    });
  });

  it("reports machine-readable entity, transform, mesh, camera, and bounds exhaustion", () => {
    const workerFactory = () =>
      ({
        addEventListener: vi.fn(),
        postMessage: vi.fn(),
        terminate: vi.fn(),
      }) as unknown as Worker;
    const engine = createEngine({} as HTMLCanvasElement, {
      autoResize: false,
      entityCapacity: 4,
      componentCapacities: { transforms: 2, meshRenderers: 1, cameras: 1, bounds: 1 },
      workerFactory,
    });
    engine.create.mesh({ geometry: "cube", bounds: { radius: 1 } });
    const secondEntity = engine.world.createEntity();
    engine.world.add(secondEntity, camera());

    const thirdEntity = engine.world.createEntity();
    expect(() =>
      engine.world.add(
        thirdEntity,
        meshComponent(engine.geometry.cube, engine.create.basicMaterial()),
      ),
    ).toThrowError(expect.objectContaining({ capacityKind: "mesh-renderer", capacity: 1 }));
    expect(() => engine.world.add(thirdEntity, camera())).toThrowError(
      expect.objectContaining({ capacityKind: "camera", capacity: 1 }),
    );
    expect(() =>
      engine.world.add(thirdEntity, { kind: "bounds", center: [0, 0, 0], radius: 1 }),
    ).toThrowError(expect.objectContaining({ capacityKind: "bounds", capacity: 1 }));
    expect(() => engine.create.mesh({ geometry: "cube" })).toThrowError(
      expect.objectContaining({
        code: "LUME_CAPACITY_EXHAUSTED",
        capacityKind: "transform",
        capacity: 2,
      }),
    );

    const finalEntity = engine.world.createEntity();
    expect(() => engine.world.createEntity()).toThrowError(
      expect.objectContaining({ capacityKind: "entity", capacity: 4 }),
    );
    expect(finalEntity.index).toBe(4);
  });

  it("preflights low transform capacity before allocating the lazy default material", () => {
    const workerFactory = () =>
      ({
        addEventListener: vi.fn(),
        postMessage: vi.fn(),
        terminate: vi.fn(),
      }) as unknown as Worker;
    const engine = createEngine({} as HTMLCanvasElement, {
      autoResize: false,
      entityCapacity: 2,
      resourceCapacity: 2,
      componentCapacities: { transforms: 1 },
      workerFactory,
    });
    const blocker = engine.world.createEntity();

    expect(() => engine.create.mesh({ geometry: "cube" })).toThrowError(EngineCapacityError);
    engine.world.destroyEntity(blocker);
    expect(engine.create.mesh({ geometry: "cube" }).id.index).toBe(blocker.index);
    expect(engine.create.basicMaterial()).toBeDefined();
    expect(() => engine.create.basicMaterial()).toThrowError(
      expect.objectContaining({ capacityKind: "material", capacity: 2 }),
    );
  });

  it("does not consume explicit-bounds capacity for an unbounded mesh", () => {
    const workerFactory = () =>
      ({
        addEventListener: vi.fn(),
        postMessage: vi.fn(),
        terminate: vi.fn(),
      }) as unknown as Worker;
    const engine = createEngine({} as HTMLCanvasElement, {
      autoResize: false,
      entityCapacity: 2,
      componentCapacities: { bounds: 0 },
      workerFactory,
    });

    expect(engine.create.mesh({ geometry: "cube" })).toBeDefined();
    expect(() => engine.create.mesh({ geometry: "cube", bounds: { radius: 1 } })).toThrowError(
      expect.objectContaining({ capacityKind: "bounds", capacity: 0 }),
    );
    expect(engine.world.createEntity()).toMatchObject({ index: 2, generation: 0 });
  });

  it("rolls back entity, material, and commands when ordered mesh publication fails", async () => {
    let onMessage: ((event: MessageEvent<WorkerToMainMessage>) => void) | undefined;
    let rejectOrderedBatch = false;
    const posted: MainToWorkerMessage[] = [];
    const worker = {
      addEventListener(type: string, listener: EventListener) {
        if (type === "message") {
          onMessage = listener as (event: MessageEvent<WorkerToMainMessage>) => void;
        }
      },
      postMessage(message: MainToWorkerMessage) {
        if (rejectOrderedBatch && message.type === "batch" && message.ordered === true) {
          throw new Error("transport rejected transaction");
        }
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
    const engine = createEngine(canvas, {
      autoResize: false,
      entityCapacity: 2,
      resourceCapacity: 2,
      workerFactory: () => worker,
    });
    const initialization = engine.init();
    onMessage?.({ data: { type: "ready" } } as MessageEvent<WorkerToMainMessage>);
    await initialization;
    posted.length = 0;

    rejectOrderedBatch = true;
    expect(() => engine.create.mesh({ geometry: "cube" })).toThrow("transport rejected");
    expect(posted).toEqual([]);

    rejectOrderedBatch = false;
    expect(engine.create.basicMaterial()).toBeDefined();
    expect(engine.create.basicMaterial()).toBeDefined();
    expect(engine.world.createEntity()).toMatchObject({ index: 1, generation: 1 });
    expect(posted.map((message) => message.type)).toEqual(["command", "command", "command"]);
  });

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

  it("does not consume entity capacity after the engine fails", async () => {
    let onMessage: ((event: MessageEvent<WorkerToMainMessage>) => void) | undefined;
    const worker = {
      addEventListener(type: string, listener: EventListener) {
        if (type === "message") {
          onMessage = listener as (event: MessageEvent<WorkerToMainMessage>) => void;
        }
      },
      postMessage: vi.fn(),
      terminate: vi.fn(),
    } as unknown as Worker;
    const canvas = {
      getBoundingClientRect: () => ({ width: 1, height: 1 }),
      transferControlToOffscreen: () => ({}) as OffscreenCanvas,
    } as HTMLCanvasElement;
    vi.stubGlobal("window", { devicePixelRatio: 1 });
    vi.stubGlobal("crossOriginIsolated", false);
    const engine = createEngine(canvas, {
      autoResize: false,
      entityCapacity: 1,
      workerFactory: () => worker,
    });
    const initialization = engine.init();
    onMessage?.({ data: { type: "error", message: "worker failed" } } as MessageEvent);
    await expect(initialization).rejects.toThrow("worker failed");

    expect(() => engine.world.createEntity()).toThrow("failed engine");
    expect(() => engine.world.createEntity()).toThrow("failed engine");
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

  it("rejects a resource capacity that cannot hold both built-in geometries", () => {
    expect(() =>
      createEngine({} as HTMLCanvasElement, {
        resourceCapacity: 1,
        workerFactory: () => ({}) as Worker,
      }),
    ).toThrow("resourceCapacity");
  });

  it("validates engine camera configuration before creating a worker", () => {
    const workerFactory = vi.fn(() => ({}) as Worker);
    expect(() =>
      createEngine({} as HTMLCanvasElement, {
        camera: { near: 10, far: 1 },
        workerFactory,
      }),
    ).toThrow("camera far");
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

  it("rejects invalid high-level transform updates before mutating or publishing", () => {
    const worker = {
      addEventListener: vi.fn(),
      postMessage: vi.fn(),
      terminate: vi.fn(),
    } as unknown as Worker;
    const engine = createEngine({} as HTMLCanvasElement, {
      autoResize: false,
      workerFactory: () => worker,
    });
    const handle = engine.create.mesh({ geometry: "cube", position: [1, 2, 3] });

    expect(() =>
      engine.set.transform(handle, {
        position: [9, 9, 9],
        rotation: [0, 0, 0, 0],
      }),
    ).toThrow("rotation must be non-zero");
    expect(() => engine.set.transform(handle, { scale: [1, Number.POSITIVE_INFINITY, 1] })).toThrow(
      "scale",
    );
    expect([handle.position.x, handle.position.y, handle.position.z]).toEqual([1, 2, 3]);
    expect([handle.scale.x, handle.scale.y, handle.scale.z]).toEqual([1, 1, 1]);
    expect(worker.postMessage).not.toHaveBeenCalled();

    engine.dispose();
    expect(() => engine.set.transform(handle, { position: [7, 8, 9] })).toThrow("disposed");
    expect(() => handle.position.set(7, 8, 9)).toThrow("disposed");
    expect([handle.position.x, handle.position.y, handle.position.z]).toEqual([1, 2, 3]);
  });

  it("rejects wrong-kind, foreign, retired, and destroyed resource handles", () => {
    const postMessage = vi.fn();
    const workerFactory = () =>
      ({
        addEventListener: vi.fn(),
        postMessage,
        terminate: vi.fn(),
      }) as unknown as Worker;
    const first = createEngine({} as HTMLCanvasElement, { autoResize: false, workerFactory });
    const second = createEngine({} as HTMLCanvasElement, { autoResize: false, workerFactory });
    const material = first.create.basicMaterial();
    const mesh = first.create.mesh({ geometry: "cube", material });

    expect(() => first.create.mesh({ geometry: material as unknown as GeometryHandle })).toThrow(
      "Expected a geometry",
    );
    expect(() => first.create.mesh({ geometry: second.geometry.cube })).toThrow("does not belong");

    first.destroy(material);
    expect(() => first.create.mesh({ geometry: "cube", material })).toThrow("retired");
    first.destroy(mesh);
    expect(() => first.create.mesh({ geometry: "cube", material })).toThrow("stale");

    const commandCount = postMessage.mock.calls.length;
    expect(() => first.destroy(first.geometry.triangle)).toThrow("Engine-owned built-in geometry");
    expect(postMessage).toHaveBeenCalledTimes(commandCount);
    expect(() => first.create.mesh({ geometry: "triangle" })).not.toThrow();
  });

  it("updates mesh resource usage transactionally across replacement and removal", () => {
    const posted: MainToWorkerMessage[] = [];
    const worker = {
      addEventListener: vi.fn(),
      postMessage: vi.fn((message: MainToWorkerMessage) => posted.push(message)),
      terminate: vi.fn(),
    } as unknown as Worker;
    const engine = createEngine({} as HTMLCanvasElement, {
      autoResize: false,
      workerFactory: () => worker,
    });
    const first = engine.create.basicMaterial({ color: [1, 0, 0, 1] });
    const second = engine.create.basicMaterial({ color: [0, 0, 1, 1] });
    const mesh = engine.create.mesh({ geometry: "cube", material: first });

    engine.world.add(mesh.id, meshComponent(engine.geometry.cube, second));
    engine.destroy(first);
    expect(() => engine.world.add(mesh.id, meshComponent(engine.geometry.cube, first))).toThrow(
      "stale",
    );
    const commandsBeforeRemoval = posted.length;
    engine.destroy(second);
    engine.world.remove(mesh.id, "mesh");
    expect(posted).toHaveLength(commandsBeforeRemoval);
    expect(() => engine.create.mesh({ geometry: "cube", material: second })).toThrow("stale");
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
        "create-geometry",
        "create-geometry",
        "spawn",
        "add-transform",
        "add-camera",
        "create-basic-material",
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

  it("captures advanced component tuples when pre-init commands are authored", async () => {
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
      getBoundingClientRect: () => ({ width: 1, height: 1 }),
      transferControlToOffscreen: () => ({}) as OffscreenCanvas,
    } as HTMLCanvasElement;
    vi.stubGlobal("window", { devicePixelRatio: 1 });
    vi.stubGlobal("crossOriginIsolated", false);
    const engine = createEngine(canvas, { autoResize: false, workerFactory: () => worker });
    const entity = engine.world.createEntity();
    const position: [number, number, number] = [1, 2, 3];
    const rotation: [number, number, number, number] = [0, 0, 0, 1];
    const scale: [number, number, number] = [1, 1, 1];
    const center: [number, number, number] = [4, 5, 6];
    engine.world.add(entity, { kind: "transform", position, rotation, scale });
    engine.world.add(entity, { kind: "bounds", center, radius: 2 });

    position[0] = 999;
    rotation[3] = Number.NaN;
    scale[1] = 999;
    center[2] = 999;

    const initialization = engine.init();
    onMessage?.({ data: { type: "ready" } } as MessageEvent<WorkerToMainMessage>);
    await initialization;
    const batch = posted.find(
      (message): message is Extract<MainToWorkerMessage, { type: "batch" }> =>
        message.type === "batch",
    );
    expect(batch?.value).toContainEqual({
      type: "add-transform",
      entity: entity.index,
      position: [1, 2, 3],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    });
    expect(batch?.value).toContainEqual({
      type: "add-bounds",
      entity: entity.index,
      center: [4, 5, 6],
      radius: 2,
    });
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

    engine.stop();
    engine.resize();
    expect(posted).toEqual([]);

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
    const messageCount = posted.length;
    engine.stop();
    engine.resize();
    engine.dispose();
    expect(posted).toHaveLength(messageCount);
  });
});
