import { describe, expect, it, vi } from "vitest";

import type { CpuMeshData } from "../geometry/mesh-data.js";
import { createMeshRegistry } from "./mesh-registry.js";

describe("mesh registry initialization ownership", () => {
  it("destroys partial buffers when a later buffer initialization fails", () => {
    vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, INDEX: 2 });
    const created: Array<{
      readonly size: number;
      readonly destroy: ReturnType<typeof vi.fn>;
      readonly getMappedRange: ReturnType<typeof vi.fn>;
      readonly unmap: ReturnType<typeof vi.fn>;
    }> = [];
    const device = {
      createBuffer: vi.fn(() => {
        const ordinal = created.length;
        const buffer = {
          size: 24,
          destroy: vi.fn(),
          getMappedRange: vi.fn(() => {
            if (ordinal === 1) throw new Error("mapping failed");
            return new ArrayBuffer(24);
          }),
          unmap: vi.fn(),
        };
        created.push(buffer);
        return buffer;
      }),
    } as unknown as GPUDevice;
    const source: CpuMeshData = {
      builtin: "triangle",
      label: "test",
      vertices: new Float32Array([0, 0, 0, 0, 0, 1]),
      indices: new Uint32Array([0]),
    };

    const registry = createMeshRegistry(device, 4);
    expect(() => registry.register(1, source)).toThrow("mapping failed");
    expect(created).toHaveLength(2);
    expect(created[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(created[1]?.destroy).toHaveBeenCalledTimes(1);
  });

  it("rejects stale geometry generations after removal and slot reuse", () => {
    vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, INDEX: 2 });
    const buffers: Array<{ size: number; destroy: ReturnType<typeof vi.fn> }> = [];
    const device = {
      createBuffer: vi.fn(() => {
        const buffer = {
          size: 24,
          destroy: vi.fn(),
          getMappedRange: vi.fn(() => new ArrayBuffer(24)),
          unmap: vi.fn(),
        };
        buffers.push(buffer);
        return buffer;
      }),
    } as unknown as GPUDevice;
    const source: CpuMeshData = {
      builtin: "triangle",
      label: "test",
      vertices: new Float32Array([0, 0, 0, 0, 0, 1]),
      indices: new Uint32Array([0]),
    };
    const registry = createMeshRegistry(device, 4);
    registry.register(1, source);
    expect(registry.get(1)).toBeDefined();
    expect(registry.remove(1)).toBe(true);
    expect(registry.get(1)).toBeUndefined();
    expect(() => registry.register(1, source)).toThrow("geometry handle");
    registry.register((1 << 20) | 1, source);
    expect(registry.get((1 << 20) | 1)).toBeDefined();
    registry.dispose();
    expect(buffers.every((buffer) => buffer.destroy.mock.calls.length === 1)).toBe(true);
  });
});
