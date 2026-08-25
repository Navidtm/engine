import type { DecodedGeometry } from "@lume/assets";
import type { MeshRenderer } from "@lume/renderer";
import { describe, expect, it, vi } from "vitest";

import { createResourceCoordinator } from "./resource-coordinator.js";
import type { WasmCore } from "./wasm.js";

const GEOMETRY_LIMITS = {
  decode: {
    maxEncodedBytes: 256,
    maxDecodedBytes: 256,
    maxVertices: 16,
    maxIndices: 48,
  },
  maxTemporaryBytes: 1_024,
  maxRetainedDecodedBytes: 512,
  maxResidentGpuBytes: 2_048,
} as const;

function decodedGeometry(encodedBytes = 32): DecodedGeometry {
  const interleavedVertices = new Float32Array([
    0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1,
  ]);
  const indices = new Uint32Array([0, 1, 2]);
  const decodedBytes = interleavedVertices.byteLength + indices.byteLength;
  return {
    interleavedVertices,
    indices,
    vertexCount: 3,
    indexCount: 3,
    sourceIndexComponentType: 5125,
    bounds: { min: [0, 0, 0], max: [1, 1, 0] },
    bytes: {
      encodedBytes,
      vertexBytes: interleavedVertices.byteLength,
      indexBytes: indices.byteLength,
      decodedBytes,
      minimumPeakBytes: encodedBytes + decodedBytes,
    },
  };
}

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
    const coordinator = createResourceCoordinator(8, 8, GEOMETRY_LIMITS);
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
    const staleAttempt = coordinator.beginGeometryLoad(1, 4);
    coordinator.abortGeometryLoad(1);
    coordinator.rollbackGeometryLoad(staleAttempt, true);
    const externalHandle = (1 << 20) | 4;
    const attempt = coordinator.beginGeometryLoad(2, externalHandle);
    coordinator.prepareGeometryDecode(attempt, 32);
    const descriptor = decodedGeometry();
    coordinator.commitGeometryLoad(attempt, descriptor, renderer);
    const replacement = dependencies().renderer;

    coordinator.rebuildRenderer(replacement);

    expect(replacement.registerGeometry).toHaveBeenCalledWith(1, "triangle");
    expect(replacement.registerGeometry).toHaveBeenCalledWith(2, "cube");
    expect(replacement.registerExternalGeometry).toHaveBeenCalledWith(externalHandle, descriptor);
    expect(replacement.registerBasicMaterial).toHaveBeenCalledWith(3);
  });

  it("keeps retired external geometry until its final mesh usage edge is released", () => {
    const coordinator = createResourceCoordinator(8, 8, GEOMETRY_LIMITS);
    const { core, renderer } = dependencies();
    const attempt = coordinator.beginGeometryLoad(10, 1);
    coordinator.prepareGeometryDecode(attempt, 32);
    const descriptor = decodedGeometry();
    coordinator.commitGeometryLoad(attempt, descriptor, renderer);
    coordinator.apply(
      { type: "create-basic-material", handle: 2, color: [1, 1, 1, 1] },
      core,
      renderer,
      1,
    );
    coordinator.apply({ type: "spawn", entity: 1 }, core, renderer, 1);
    coordinator.apply({ type: "add-mesh", entity: 1, geometry: 1, material: 2 }, core, renderer, 1);

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
    expect(coordinator.assetStats()).toMatchObject({
      retainedDecodedBytes: 0,
      residentGpuBytes: 0,
    });
  });

  it("commits concurrent external loads atomically with exact accounting", () => {
    const coordinator = createResourceCoordinator(8, 8, GEOMETRY_LIMITS);
    const { renderer } = dependencies();
    const first = coordinator.beginGeometryLoad(11, 1);
    const second = coordinator.beginGeometryLoad(12, 2);
    expect(coordinator.assetStats()).toMatchObject({
      pendingLoads: 2,
      temporaryReservedBytes: 1_024,
    });
    expect(() => coordinator.beginGeometryLoad(13, 3)).toThrow("Temporary geometry reservations");

    coordinator.prepareGeometryDecode(first, 32);
    coordinator.prepareGeometryDecode(second, 32);
    const descriptor = decodedGeometry();
    coordinator.commitGeometryLoad(first, descriptor, renderer);
    coordinator.rollbackGeometryLoad(second, false);

    expect(renderer.registerExternalGeometry).toHaveBeenCalledWith(1, descriptor);
    expect(coordinator.assetStats()).toEqual({
      pendingLoads: 0,
      successfulLoads: 1,
      failedLoads: 2,
      abortedLoads: 0,
      fetchedEncodedBytes: 64,
      temporaryReservedBytes: 0,
      retainedDecodedBytes: descriptor.bytes.decodedBytes,
      residentGpuBytes: descriptor.bytes.decodedBytes,
    });
  });

  it("invalidates aborted attempts before slot reuse and rejects late publication", () => {
    const coordinator = createResourceCoordinator(4, 4, GEOMETRY_LIMITS);
    const { renderer } = dependencies();
    const stale = coordinator.beginGeometryLoad(21, 1);
    coordinator.prepareGeometryDecode(stale, 32);
    expect(coordinator.abortGeometryLoad(21)).toBe(true);
    expect(coordinator.isGeometryLoadCurrent(stale)).toBe(false);
    coordinator.rollbackGeometryLoad(stale, true);

    expect(() => coordinator.beginGeometryLoad(22, 1)).toThrow("identity");
    const nextHandle = (1 << 20) | 1;
    const current = coordinator.beginGeometryLoad(22, nextHandle);
    coordinator.prepareGeometryDecode(current, 32);
    expect(() => coordinator.commitGeometryLoad(stale, decodedGeometry(), renderer)).toThrow(
      "no longer current",
    );
    coordinator.commitGeometryLoad(current, decodedGeometry(), renderer);

    expect(renderer.registerExternalGeometry).toHaveBeenCalledTimes(1);
    expect(renderer.registerExternalGeometry).toHaveBeenCalledWith(nextHandle, expect.any(Object));
    expect(coordinator.assetStats().abortedLoads).toBe(1);
  });

  it("rolls back renderer upload failure without publishing a ready record", () => {
    const coordinator = createResourceCoordinator(4, 4, GEOMETRY_LIMITS);
    const { renderer } = dependencies();
    vi.mocked(renderer.registerExternalGeometry).mockImplementationOnce(() => {
      throw new Error("GPU allocation failed");
    });
    const attempt = coordinator.beginGeometryLoad(31, 1);
    coordinator.prepareGeometryDecode(attempt, 32);

    expect(() => coordinator.commitGeometryLoad(attempt, decodedGeometry(), renderer)).toThrow(
      "GPU allocation failed",
    );
    coordinator.rollbackGeometryLoad(attempt, false);
    expect(coordinator.assetStats()).toMatchObject({
      pendingLoads: 0,
      successfulLoads: 0,
      failedLoads: 1,
      retainedDecodedBytes: 0,
      residentGpuBytes: 0,
    });
    expect(() => coordinator.beginGeometryLoad(32, 1)).toThrow("identity");
    expect(() => coordinator.beginGeometryLoad(32, (1 << 20) | 1)).not.toThrow();
  });

  it("destroys uploaded buffers when abort wins immediately before publication", () => {
    const coordinator = createResourceCoordinator(4, 4, GEOMETRY_LIMITS);
    const { renderer } = dependencies();
    const attempt = coordinator.beginGeometryLoad(33, 1);
    coordinator.prepareGeometryDecode(attempt, 32);
    vi.mocked(renderer.registerExternalGeometry).mockImplementationOnce(() => {
      coordinator.abortGeometryLoad(33);
    });

    expect(() => coordinator.commitGeometryLoad(attempt, decodedGeometry(), renderer)).toThrow(
      "no longer current",
    );
    expect(renderer.removeGeometry).toHaveBeenCalledWith(1);
    coordinator.rollbackGeometryLoad(attempt, true);
    expect(coordinator.assetStats()).toMatchObject({
      pendingLoads: 0,
      successfulLoads: 0,
      abortedLoads: 1,
      retainedDecodedBytes: 0,
      residentGpuBytes: 0,
    });
  });

  it("rejects retained decoded budget before allocating renderer buffers", () => {
    const coordinator = createResourceCoordinator(4, 4, {
      ...GEOMETRY_LIMITS,
      maxRetainedDecodedBytes: 80,
    });
    const { renderer } = dependencies();
    const attempt = coordinator.beginGeometryLoad(34, 1);
    coordinator.prepareGeometryDecode(attempt, 32);

    expect(() => coordinator.commitGeometryLoad(attempt, decodedGeometry(), renderer)).toThrow(
      "Retained decoded geometry",
    );
    expect(renderer.registerExternalGeometry).not.toHaveBeenCalled();
    coordinator.rollbackGeometryLoad(attempt, false);
    expect(coordinator.assetStats()).toMatchObject({
      failedLoads: 1,
      retainedDecodedBytes: 0,
      residentGpuBytes: 0,
    });
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
