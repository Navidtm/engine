/** Readonly-TypeScript CPU-side mesh source accepted by the built-in mesh registry. */
export interface CpuMeshData {
  /** Positive renderer-local geometry identifier. */
  readonly handle: number;
  /** Diagnostic label used for WebGPU resources and validation errors. */
  readonly label: string;
  /** Interleaved position.xyz and normal.xyz values. */
  readonly vertices: Float32Array<ArrayBuffer>;
  /** Triangle-list indices into `vertices`. */
  readonly indices: Uint32Array<ArrayBuffer>;
}

const TRIANGLE_VERTICES = new Float32Array([
  0.0, 0.7, 0.0, 0.0, 0.0, 1.0, -0.7, -0.6, 0.0, 0.0, 0.0, 1.0, 0.7, -0.6, 0.0, 0.0, 0.0, 1.0,
]);
const TRIANGLE_INDICES = new Uint32Array([0, 1, 2]);

const CUBE_VERTICES = new Float32Array([
  // +Z
  -0.5, -0.5, 0.5, 0, 0, 1, 0.5, -0.5, 0.5, 0, 0, 1, 0.5, 0.5, 0.5, 0, 0, 1, -0.5, 0.5, 0.5, 0, 0,
  1,
  // -Z
  0.5, -0.5, -0.5, 0, 0, -1, -0.5, -0.5, -0.5, 0, 0, -1, -0.5, 0.5, -0.5, 0, 0, -1, 0.5, 0.5, -0.5,
  0, 0, -1,
  // +X
  0.5, -0.5, 0.5, 1, 0, 0, 0.5, -0.5, -0.5, 1, 0, 0, 0.5, 0.5, -0.5, 1, 0, 0, 0.5, 0.5, 0.5, 1, 0,
  0,
  // -X
  -0.5, -0.5, -0.5, -1, 0, 0, -0.5, -0.5, 0.5, -1, 0, 0, -0.5, 0.5, 0.5, -1, 0, 0, -0.5, 0.5, -0.5,
  -1, 0, 0,
  // +Y
  -0.5, 0.5, 0.5, 0, 1, 0, 0.5, 0.5, 0.5, 0, 1, 0, 0.5, 0.5, -0.5, 0, 1, 0, -0.5, 0.5, -0.5, 0, 1,
  0,
  // -Y
  -0.5, -0.5, -0.5, 0, -1, 0, 0.5, -0.5, -0.5, 0, -1, 0, 0.5, -0.5, 0.5, 0, -1, 0, -0.5, -0.5, 0.5,
  0, -1, 0,
]);

const FACE_INDICES = [0, 1, 2, 0, 2, 3];
const CUBE_INDICES = new Uint32Array(36);
for (let face = 0; face < 6; face += 1) {
  const vertexOffset = face * 4;
  const indexOffset = face * 6;
  for (let index = 0; index < 6; index += 1) {
    CUBE_INDICES[indexOffset + index] = vertexOffset + (FACE_INDICES[index] ?? 0);
  }
}

/** Readonly-TypeScript triangle and cube source meshes addressed by scene geometry IDs. */
export const BUILTIN_MESHES = [
  {
    handle: 1,
    label: "Lume triangle mesh",
    vertices: TRIANGLE_VERTICES,
    indices: TRIANGLE_INDICES,
  },
  {
    handle: 2,
    label: "Lume indexed cube mesh",
    vertices: CUBE_VERTICES,
    indices: CUBE_INDICES,
  },
] as const satisfies readonly CpuMeshData[];
