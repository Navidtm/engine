/** Per-request limits required before decoding untrusted geometry bytes. */
export interface GeometryDecodeLimits {
  /** Maximum complete GLB container size accepted by the decoder. */
  readonly maxEncodedBytes: number;
  /** Maximum final interleaved vertex plus widened-index bytes. */
  readonly maxDecodedBytes: number;
  /** Maximum decoded vertex count. */
  readonly maxVertices: number;
  /** Maximum triangle-list index count. */
  readonly maxIndices: number;
}

/**
 * Validates and snapshots immutable decoder limits.
 *
 * Milestone 7 intentionally has no defaults until fixture measurements establish
 * appropriate web product geometry budgets.
 */
export function defineGeometryDecodeLimits(
  limits: GeometryDecodeLimits,
): Readonly<GeometryDecodeLimits> {
  return Object.freeze({
    maxEncodedBytes: positiveSafeInteger(limits.maxEncodedBytes, "maxEncodedBytes"),
    maxDecodedBytes: positiveSafeInteger(limits.maxDecodedBytes, "maxDecodedBytes"),
    maxVertices: positiveSafeInteger(limits.maxVertices, "maxVertices"),
    maxIndices: positiveSafeInteger(limits.maxIndices, "maxIndices"),
  });
}

function positiveSafeInteger(value: number, name: keyof GeometryDecodeLimits): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}
