/** Index component widths accepted from the constrained GLB profile. */
export type GlbIndexComponentType = 5123 | 5125;

/** Exact owned-array accounting produced by one successful geometry decode. */
export interface GeometryByteAccounting {
  readonly encodedBytes: number;
  readonly vertexBytes: number;
  readonly indexBytes: number;
  readonly decodedBytes: number;
  /** Lower bound while the encoded input and decoded arrays are simultaneously live. */
  readonly minimumPeakBytes: number;
}

/** Verified mesh-local POSITION bounds derived from decoded float32 values. */
export interface GeometryBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** Device-independent, replayable geometry descriptor owned outside the renderer. */
export interface DecodedGeometry {
  /** Interleaved position.xyz and normal.xyz values. */
  readonly interleavedVertices: Float32Array<ArrayBuffer>;
  /** Triangle-list indices widened to the renderer's current `uint32` layout. */
  readonly indices: Uint32Array<ArrayBuffer>;
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly sourceIndexComponentType: GlbIndexComponentType;
  readonly bounds: GeometryBounds;
  readonly bytes: GeometryByteAccounting;
}
