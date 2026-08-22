import type { CpuMeshData } from "../geometry/mesh-data.js";
import { createStaticBuffer } from "./buffer.js";

/** GPU buffers and draw metadata for one immutable indexed mesh. */
export interface GpuMesh {
  /** Position/normal vertex buffer. */
  readonly vertexBuffer: GPUBuffer;
  /** Unsigned 32-bit index buffer. */
  readonly indexBuffer: GPUBuffer;
  /** Number of indices supplied to `drawIndexed`. */
  readonly indexCount: number;
  /** Total bytes reserved by both GPU buffers. */
  readonly byteLength: number;
}

/** Owns the built-in mesh GPU buffers for one renderer lifetime. */
export interface MeshRegistry {
  /** Registers one built-in source under a complete generational resource key. */
  register(handle: number, source: CpuMeshData): void;
  /** Removes and destroys a matching resource generation. */
  remove(handle: number): boolean;
  /** Looks up a mesh by its complete generational resource key. */
  get(handle: number): GpuMesh | undefined;
  /** Current total bytes owned by the registry. */
  readonly gpuBytes: number;
  /** Idempotently destroys all owned GPU buffers. */
  dispose(): void;
}

/** Uploads validated mesh sources transactionally and returns their owner registry. */
export function createMeshRegistry(device: GPUDevice, capacity: number): MeshRegistry {
  const meshes: Array<GpuMesh | undefined> = new Array(capacity);
  const generations = new Uint16Array(capacity);
  const occupied = new Uint8Array(capacity);
  let gpuBytes = 0;
  let disposed = false;

  const registry: MeshRegistry = {
    register(handle, source) {
      if (disposed) throw new Error("Cannot register geometry after renderer disposal.");
      const index = handle & 0x000f_ffff;
      const generation = handle >>> 20;
      if (
        index <= 0 ||
        index >= capacity ||
        occupied[index] !== 0 ||
        generations[index] !== generation
      ) {
        throw new Error(`Invalid or occupied geometry handle: ${handle}`);
      }
      if (source.vertices.length % 6 !== 0 || source.indices.length === 0) {
        throw new Error(`Mesh '${source.label}' has an invalid vertex/index layout.`);
      }
      const vertexBuffer = createStaticBuffer(
        device,
        `${source.label} vertices`,
        GPUBufferUsage.VERTEX,
        source.vertices,
      );
      let indexBuffer: GPUBuffer;
      try {
        indexBuffer = createStaticBuffer(
          device,
          `${source.label} indices`,
          GPUBufferUsage.INDEX,
          source.indices,
        );
      } catch (error) {
        vertexBuffer.destroy();
        throw error;
      }
      const byteLength = vertexBuffer.size + indexBuffer.size;
      gpuBytes += byteLength;
      meshes[index] = {
        vertexBuffer,
        indexBuffer,
        indexCount: source.indices.length,
        byteLength,
      };
      generations[index] = generation;
      occupied[index] = 1;
    },
    remove(handle) {
      const index = handle & 0x000f_ffff;
      if (
        index <= 0 ||
        index >= capacity ||
        occupied[index] === 0 ||
        generations[index] !== handle >>> 20
      ) {
        return false;
      }
      const mesh = meshes[index];
      mesh?.vertexBuffer.destroy();
      mesh?.indexBuffer.destroy();
      gpuBytes -= mesh?.byteLength ?? 0;
      meshes[index] = undefined;
      occupied[index] = 0;
      generations[index] = (generations[index] + 1) & 0x0fff;
      return true;
    },
    get(handle) {
      const index = handle & 0x000f_ffff;
      return occupied[index] !== 0 && generations[index] === handle >>> 20
        ? meshes[index]
        : undefined;
    },
    get gpuBytes() {
      return gpuBytes;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const mesh of meshes) {
        mesh?.vertexBuffer.destroy();
        mesh?.indexBuffer.destroy();
      }
      occupied.fill(0);
      gpuBytes = 0;
    },
  };
  return registry;
}
