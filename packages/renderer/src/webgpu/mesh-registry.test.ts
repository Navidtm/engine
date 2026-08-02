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
      handle: 1,
      label: "test",
      vertices: new Float32Array([0, 0, 0, 0, 0, 1]),
      indices: new Uint32Array([0]),
    };

    expect(() => createMeshRegistry(device, [source])).toThrow("mapping failed");
    expect(created).toHaveLength(2);
    expect(created[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(created[1]?.destroy).toHaveBeenCalledTimes(1);
  });
});
