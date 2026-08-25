/** Stable application-facing asset failure categories shared across loading stages. */
export type AssetErrorCode =
  | "LUME_ASSET_ABORTED"
  | "LUME_ASSET_NETWORK"
  | "LUME_ASSET_FORMAT"
  | "LUME_ASSET_UNSUPPORTED"
  | "LUME_ASSET_CAPACITY_EXHAUSTED"
  | "LUME_ASSET_BUDGET_EXCEEDED"
  | "LUME_ASSET_GPU_UPLOAD";

/** Stable stage identifiers safe to transfer across the worker boundary. */
export type AssetErrorStage =
  | "request"
  | "fetch"
  | "container"
  | "json"
  | "schema"
  | "geometry"
  | "budget"
  | "upload"
  | "recovery"
  | "lifecycle";

/** Typed asset failure without source bytes, URLs, or engine-internal state. */
export class AssetError extends Error {
  override readonly name = "AssetError";

  constructor(
    readonly code: AssetErrorCode,
    readonly stage: AssetErrorStage,
    message: string,
  ) {
    super(message);
  }
}

const ASSET_ERROR_CODES: ReadonlySet<string> = new Set<AssetErrorCode>([
  "LUME_ASSET_ABORTED",
  "LUME_ASSET_NETWORK",
  "LUME_ASSET_FORMAT",
  "LUME_ASSET_UNSUPPORTED",
  "LUME_ASSET_CAPACITY_EXHAUSTED",
  "LUME_ASSET_BUDGET_EXCEEDED",
  "LUME_ASSET_GPU_UPLOAD",
]);
const ASSET_ERROR_STAGES: ReadonlySet<string> = new Set<AssetErrorStage>([
  "request",
  "fetch",
  "container",
  "json",
  "schema",
  "geometry",
  "budget",
  "upload",
  "recovery",
  "lifecycle",
]);

/** Narrows unknown failures without relying on cross-realm `instanceof` behavior. */
export function isAssetError(value: unknown): value is AssetError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { readonly code?: unknown; readonly stage?: unknown };
  return (
    typeof candidate.code === "string" &&
    ASSET_ERROR_CODES.has(candidate.code) &&
    typeof candidate.stage === "string" &&
    ASSET_ERROR_STAGES.has(candidate.stage)
  );
}
