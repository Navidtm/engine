import type { CpuMeshData } from "../geometry/mesh-data.js";
import { createStaticBuffer } from "./buffer.js";

export interface GpuMesh {
  readonly vertexBuffer: GPUBuffer;
  readonly indexBuffer: GPUBuffer;
  readonly indexCount: number;
  readonly byteLength: number;
}

export interface MeshRegistry {
  get(handle: number): GpuMesh | undefined;
  readonly gpuBytes: number;
  dispose(): void;
}

export function createMeshRegistry(
  device: GPUDevice,
  sources: readonly CpuMeshData[],
): MeshRegistry {
  let maxHandle = 0;
  for (const source of sources) maxHandle = Math.max(maxHandle, source.handle);
  const meshes: Array<GpuMesh | undefined> = new Array(maxHandle + 1);
  let gpuBytes = 0;

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
    const indexBuffer = createStaticBuffer(
      device,
      `${source.label} indices`,
      GPUBufferUsage.INDEX,
      source.indices,
    );
    const byteLength = vertexBuffer.size + indexBuffer.size;
    gpuBytes += byteLength;
    meshes[source.handle] = Object.freeze({
      vertexBuffer,
      indexBuffer,
      indexCount: source.indices.length,
      byteLength,
    });
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
  return Object.freeze(registry);
}
