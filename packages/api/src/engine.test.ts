import type { MainToWorkerMessage, WorkerToMainMessage } from "@lume/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createEngine } from "./engine.js";

afterEach(() => vi.unstubAllGlobals());

describe("high-level engine API", () => {
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
      wasmUrl: "/lume_core.wasm",
    });
    const blue = engine.create.basicMaterial({ color: [0.2, 0.4, 1, 1] });
    const cube = engine.create.mesh({ geometry: "cube", material: blue, position: [0, 0, -5] });
    engine.create.perspectiveCamera();

    expect(Object.isFrozen(cube)).toBe(true);
    const initialization = engine.init();
    expect(posted[0]?.type).toBe("init");
    onMessage?.({ data: { type: "ready" } } as MessageEvent<WorkerToMainMessage>);
    await initialization;

    const batch = posted[1];
    expect(batch?.type).toBe("batch");
    if (batch?.type === "batch") {
      expect(batch.value.map((command) => command.type)).toEqual([
        "spawn",
        "add-material",
        "spawn",
        "add-transform",
        "add-mesh",
        "spawn",
        "add-transform",
        "add-camera",
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
});
