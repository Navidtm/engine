import { defineGeometryDecodeLimits, type GeometryDecodeLimits } from "@lume/assets";

/** Immutable worker budgets for external geometry transactions. */
export interface RuntimeGeometryLimits {
  readonly decode: GeometryDecodeLimits;
  /** Maximum aggregate temporary download/decode reservations. */
  readonly maxTemporaryBytes: number;
  /** Maximum decoded arrays retained by ready external geometry records. */
  readonly maxRetainedDecodedBytes: number;
  /** Maximum renderer buffer bytes owned by all geometry records. */
  readonly maxResidentGpuBytes: number;
}

/** Validates and snapshots runtime geometry budgets without selecting defaults. */
export function defineRuntimeGeometryLimits(
  limits: RuntimeGeometryLimits,
): Readonly<RuntimeGeometryLimits> {
  const decode = defineGeometryDecodeLimits(limits.decode);
  return Object.freeze({
    decode,
    maxTemporaryBytes: positiveSafeInteger(limits.maxTemporaryBytes, "maxTemporaryBytes"),
    maxRetainedDecodedBytes: positiveSafeInteger(
      limits.maxRetainedDecodedBytes,
      "maxRetainedDecodedBytes",
    ),
    maxResidentGpuBytes: positiveSafeInteger(limits.maxResidentGpuBytes, "maxResidentGpuBytes"),
  });
}

function positiveSafeInteger(value: number, name: keyof RuntimeGeometryLimits): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}
