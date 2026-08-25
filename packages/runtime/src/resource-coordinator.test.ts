import type { MeshRenderer } from "@lume/renderer";
import { describe, expect, it, vi } from "vitest";

import { createResourceCoordinator } from "./resource-coordinator.js";
import type { WasmCore } from "./wasm.js";

function dependencies() {
  const core = {
    createBasicMaterial: vi.fn(),
    removeBasicMaterial: vi.fn(),
    apply: vi.fn(),
    updateSharedCommands: vi.fn(),
    updateSharedTransforms: vi.fn(),
    resize: vi.fn(),
    update: vi.fn(),
    stats: vi.fn(),
    dispose: vi.fn(),
  } as unknown as WasmCore;
  const renderer = {
    lost: new Promise<GPUDeviceLostInfo>(() => undefined),
    registerGeometry: vi.fn(),
    registerExternalGeometry: vi.fn(),
    removeGeometry: vi.fn(),
    registerBasicMaterial: vi.fn(),
    removeBasicMaterial: vi.fn(),
    execute: vi.fn(),
    resize: vi.fn(),
    stats: vi.fn(),
    dispose: vi.fn(),
  } as unknown as MeshRenderer;
  return { core, renderer };
}

describe("worker resource coordinator", () => {
  it("accepts the engine-owned entity-zero camera lifecycle", () => {
    const coordinator = createResourceCoordinator(8);
    const { core, renderer } = dependencies();

    coordinator.apply({ type: "spawn", entity: 0 }, core, renderer, 1);
    coordinator.apply(
      {
        type: "add-camera",
        entity: 0,
        verticalFov: 1,
        near: 0.1,
        far: 100,
      },
      core,
      renderer,
      1,
    );
    coordinator.apply({ type: "despawn", entity: 0 }, core, renderer, 1);

    expect(core.apply).toHaveBeenCalledTimes(3);
  });

  it("keeps retired resources alive until the last mesh usage edge is released", () => {
    const coordinator = createResourceCoordinator(8);
    const { core, renderer } = dependencies();
    coordinator.apply(
      { type: "create-geometry", handle: 1, builtin: "triangle" },
      core,
      renderer,
      1,
    );
    coordinator.apply(
      { type: "create-basic-material", handle: 1, color: [1, 1, 1, 1] },
      core,
      renderer,
      1,
    );
    coordinator.apply({ type: "spawn", entity: 1 }, core, renderer, 1);
    coordinator.apply({ type: "add-mesh", entity: 1, geometry: 1, material: 1 }, core, renderer, 1);

    coordinator.apply(
      { type: "retire-resource", resourceKind: "geometry", handle: 1 },
      core,
      renderer,
      1,
    );
    coordinator.apply(
      { type: "retire-resource", resourceKind: "basic-material", handle: 1 },
      core,
      renderer,
      1,
    );
    expect(renderer.removeGeometry).not.toHaveBeenCalled();
    expect(core.removeBasicMaterial).not.toHaveBeenCalled();

    coordinator.apply({ type: "spawn", entity: 2 }, core, renderer, 1);
    expect(() =>
      coordinator.apply(
        { type: "add-mesh", entity: 2, geometry: 1, material: 1 },
        core,
        renderer,
        1,
      ),
    ).toThrow("retired");

    coordinator.apply({ type: "despawn", entity: 1 }, core, renderer, 1);
    expect(renderer.removeGeometry).toHaveBeenCalledWith(1);
    expect(core.removeBasicMaterial).toHaveBeenCalledWith(1);
    expect(renderer.removeBasicMaterial).toHaveBeenCalledWith(1);
  });

  it("rejects wrong-kind and stale keys without partially replacing mesh usage", () => {
    const coordinator = createResourceCoordinator(8);
    const { core, renderer } = dependencies();
    coordinator.apply({ type: "create-geometry", handle: 1, builtin: "cube" }, core, renderer, 1);
    coordinator.apply(
      { type: "create-basic-material", handle: 2, color: [1, 0, 0, 1] },
      core,
      renderer,
      1,
    );
    coordinator.apply({ type: "spawn", entity: 1 }, core, renderer, 1);
    coordinator.apply({ type: "add-mesh", entity: 1, geometry: 1, material: 2 }, core, renderer, 1);

    expect(() =>
      coordinator.apply(
        { type: "add-mesh", entity: 1, geometry: 2, material: 2 },
        core,
        renderer,
        1,
      ),
    ).toThrow("resource handle");
    coordinator.apply(
      { type: "retire-resource", resourceKind: "geometry", handle: 1 },
      core,
      renderer,
      1,
    );
    expect(renderer.removeGeometry).not.toHaveBeenCalled();
    coordinator.apply(
      { type: "remove-component", entity: 1, component: "mesh" },
      core,
      renderer,
      1,
    );
    expect(renderer.removeGeometry).toHaveBeenCalledWith(1);
    expect(() =>
      coordinator.apply({ type: "create-geometry", handle: 1, builtin: "cube" }, core, renderer, 1),
    ).toThrow("stale");
    coordinator.apply(
      { type: "create-geometry", handle: (1 << 20) | 1, builtin: "cube" },
      core,
      renderer,
      1,
    );
  });

  it("releases every live registry entry during engine-wide disposal", () => {
    const coordinator = createResourceCoordinator(8);
    const { core, renderer } = dependencies();
    coordinator.apply(
      { type: "create-geometry", handle: 1, builtin: "triangle" },
      core,
      renderer,
      1,
    );
    coordinator.apply(
      { type: "create-basic-material", handle: 1, color: [1, 1, 1, 1] },
      core,
      renderer,
      1,
    );

    coordinator.dispose(core, renderer);
    coordinator.dispose(core, renderer);
    expect(renderer.removeGeometry).toHaveBeenCalledTimes(1);
    expect(core.removeBasicMaterial).toHaveBeenCalledTimes(1);
    expect(renderer.removeBasicMaterial).toHaveBeenCalledTimes(1);
  });

  it("rolls back renderer residency when Rust material creation fails", () => {
    const coordinator = createResourceCoordinator(8);
    const { core, renderer } = dependencies();
    vi.mocked(core.createBasicMaterial).mockImplementationOnce(() => {
      throw new Error("material capacity exhausted");
    });

    expect(() =>
      coordinator.apply(
        { type: "create-basic-material", handle: 1, color: [1, 1, 1, 1] },
        core,
        renderer,
        1,
      ),
    ).toThrow("capacity exhausted");
    expect(renderer.removeBasicMaterial).toHaveBeenCalledWith(1);

    coordinator.apply(
      { type: "create-basic-material", handle: 1, color: [1, 1, 1, 1] },
      core,
      renderer,
      1,
    );
    expect(renderer.registerBasicMaterial).toHaveBeenCalledTimes(2);
  });

  it("rebuilds every live renderer resource after device loss", () => {
    const coordinator = createResourceCoordinator(8);
    const { core, renderer } = dependencies();
    coordinator.apply(
      { type: "create-geometry", handle: 1, builtin: "triangle" },
      core,
      renderer,
      1,
    );
    coordinator.apply({ type: "create-geometry", handle: 2, builtin: "cube" }, core, renderer, 1);
    coordinator.apply(
      { type: "create-basic-material", handle: 3, color: [1, 1, 1, 1] },
      core,
      renderer,
      1,
    );
    const replacement = dependencies().renderer;

    coordinator.rebuildRenderer(replacement);

    expect(replacement.registerGeometry).toHaveBeenCalledWith(1, "triangle");
    expect(replacement.registerGeometry).toHaveBeenCalledWith(2, "cube");
    expect(replacement.registerBasicMaterial).toHaveBeenCalledWith(3);
  });

  it("retires a resource slot before its packed generation can wrap", () => {
    const coordinator = createResourceCoordinator(2);
    const { core, renderer } = dependencies();
    for (let generation = 0; generation <= 0x0fff; generation += 1) {
      const handle = (generation << 20) | 1;
      coordinator.apply(
        { type: "create-basic-material", handle, color: [1, 1, 1, 1] },
        core,
        renderer,
        1,
      );
      coordinator.apply(
        { type: "retire-resource", resourceKind: "basic-material", handle },
        core,
        renderer,
        1,
      );
    }

    expect(() =>
      coordinator.apply(
        { type: "create-basic-material", handle: 1, color: [1, 1, 1, 1] },
        core,
        renderer,
        1,
      ),
    ).toThrow("stale");
  });
});
