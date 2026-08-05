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
  /** Looks up a mesh by its positive scene geometry handle. */
  get(handle: number): GpuMesh | undefined;
  /** Current total bytes owned by the registry. */
  readonly gpuBytes: number;
  /** Idempotently destroys all owned GPU buffers. */
  dispose(): void;
}

/** Uploads validated mesh sources transactionally and returns their owner registry. */
export function createMeshRegistry(
  device: GPUDevice,
  sources: readonly CpuMeshData[],
): MeshRegistry {
  let maxHandle = 0;
  for (const source of sources) maxHandle = Math.max(maxHandle, source.handle);
  const meshes: Array<GpuMesh | undefined> = new Array(maxHandle + 1);
  let gpuBytes = 0;

  try {
    for (const source of sources) {
      if (source.handle <= 0 || meshes[source.handle] !== undefined) {
        throw new Error(`Invalid or duplicate mesh handle: ${source.handle}`);
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
      meshes[source.handle] = {
        vertexBuffer,
        indexBuffer,
        indexCount: source.indices.length,
        byteLength,
      };
    }
  } catch (error) {
    for (const mesh of meshes) {
      mesh?.vertexBuffer.destroy();
      mesh?.indexBuffer.destroy();
    }
    throw error;
  }

  let disposed = false;
  const registry: MeshRegistry = {
    get: (handle) => meshes[handle],
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
      gpuBytes = 0;
    },
  };
  return registry;
}
