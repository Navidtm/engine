import { describe, expect, it, vi } from "vitest";

import type { MeshGeometryDescriptor } from "../geometry/mesh-data.js";
import { createMeshRegistry } from "./mesh-registry.js";

interface TestBuffer {
  readonly size: number;
  readonly bytes: ArrayBuffer;
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly getMappedRange: ReturnType<typeof vi.fn>;
  readonly unmap: ReturnType<typeof vi.fn>;
}

const SOURCE: MeshGeometryDescriptor = {
  label: "external test mesh",
  interleavedVertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
};

function createTestDevice(failingMapOrdinal = -1): {
  readonly device: GPUDevice;
  readonly buffers: TestBuffer[];
  readonly createBuffer: ReturnType<typeof vi.fn>;
} {
  const buffers: TestBuffer[] = [];
  const createBuffer = vi.fn((descriptor: GPUBufferDescriptor) => {
    const ordinal = buffers.length;
    const bytes = new ArrayBuffer(Number(descriptor.size));
    const buffer: TestBuffer = {
      size: Number(descriptor.size),
      bytes,
      destroy: vi.fn(),
      getMappedRange: vi.fn(() => {
        if (ordinal === failingMapOrdinal) throw new Error("mapping failed");
        return bytes;
      }),
      unmap: vi.fn(),
    };
    buffers.push(buffer);
    return buffer;
  });
  return { device: { createBuffer } as unknown as GPUDevice, buffers, createBuffer };
}

function bufferBytesAt(buffers: readonly TestBuffer[], index: number): ArrayBuffer {
  const buffer = buffers[index];
  if (buffer === undefined) throw new Error(`Missing test buffer at index ${index}.`);
  return buffer.bytes;
}

describe("mesh registry external geometry ownership", () => {
  it("destroys partial buffers and publishes no entry when index creation fails", () => {
    vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, INDEX: 2 });
    const { device, buffers } = createTestDevice(1);
    const registry = createMeshRegistry(device, 4);

    expect(() => registry.register(1, SOURCE)).toThrow("mapping failed");
    expect(registry.get(1)).toBeUndefined();
    expect(registry.gpuBytes).toBe(0);
    expect(buffers).toHaveLength(2);
    expect(buffers[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(buffers[1]?.destroy).toHaveBeenCalledTimes(1);
  });

  it("registers, completely destroys, and replays external arrays with the same handle", () => {
    vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, INDEX: 2 });
    const liveHandle = (7 << 20) | 1;
    const first = createTestDevice();
    const firstRegistry = createMeshRegistry(first.device, 4);
    firstRegistry.register(liveHandle, SOURCE);

    expect(firstRegistry.get(liveHandle)?.indexCount).toBe(3);
    expect(firstRegistry.gpuBytes).toBe(
      SOURCE.interleavedVertices.byteLength + SOURCE.indices.byteLength,
    );
    expect([...new Float32Array(bufferBytesAt(first.buffers, 0))]).toEqual([
      ...SOURCE.interleavedVertices,
    ]);
    expect([...new Uint32Array(bufferBytesAt(first.buffers, 1))]).toEqual([...SOURCE.indices]);

    firstRegistry.dispose();
    firstRegistry.dispose();
    expect(first.buffers.every((buffer) => buffer.destroy.mock.calls.length === 1)).toBe(true);
    expect(firstRegistry.gpuBytes).toBe(0);

    const replacement = createTestDevice();
    const replacementRegistry = createMeshRegistry(replacement.device, 4);
    replacementRegistry.register(liveHandle, SOURCE);
    expect(replacementRegistry.get(liveHandle)?.indexCount).toBe(3);
    expect([...new Float32Array(bufferBytesAt(replacement.buffers, 0))]).toEqual([
      ...SOURCE.interleavedVertices,
    ]);
    expect([...new Uint32Array(bufferBytesAt(replacement.buffers, 1))]).toEqual([
      ...SOURCE.indices,
    ]);
    expect(replacementRegistry.remove(liveHandle)).toBe(true);
    expect(replacement.buffers.every((buffer) => buffer.destroy.mock.calls.length === 1)).toBe(
      true,
    );
  });

  it("rejects resource-capacity overflow before creating GPU buffers", () => {
    vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, INDEX: 2 });
    const { device, createBuffer } = createTestDevice();
    const registry = createMeshRegistry(device, 2);

    expect(() => registry.register(2, SOURCE)).toThrow("geometry handle");
    expect(createBuffer).not.toHaveBeenCalled();
    registry.register(1, SOURCE);
    expect(() => registry.register(3, SOURCE)).toThrow("geometry handle");
    expect(createBuffer).toHaveBeenCalledTimes(2);
    expect(registry.get(1)).toBeDefined();
  });

  it("rejects stale geometry generations after removal and slot reuse", () => {
    vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, INDEX: 2 });
    const { device } = createTestDevice();
    const registry = createMeshRegistry(device, 4);
    registry.register(1, SOURCE);
    expect(registry.remove(1)).toBe(true);
    expect(registry.get(1)).toBeUndefined();
    expect(() => registry.register(1, SOURCE)).toThrow("geometry handle");

    const nextHandle = (1 << 20) | 1;
    registry.register(nextHandle, SOURCE);
    expect(registry.get(nextHandle)).toBeDefined();
  });

  it("retires a geometry slot before its packed generation can wrap", () => {
    vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, INDEX: 2 });
    const { device } = createTestDevice();
    const registry = createMeshRegistry(device, 2);
    for (let generation = 0; generation <= 0x0fff; generation += 1) {
      const handle = (generation << 20) | 1;
      registry.register(handle, SOURCE);
      expect(registry.remove(handle)).toBe(true);
    }

    expect(() => registry.register(1, SOURCE)).toThrow("geometry handle");
  });
});
