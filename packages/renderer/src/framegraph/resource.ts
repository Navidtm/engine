/** Opaque logical resource used only to declare frame-graph dependencies. */
export interface FrameResource {
  /** Stable graph-local non-negative resource index. */
  readonly id: number;
  /** Human-readable identifier used in validation errors. */
  readonly name: string;
}

/** Creates an immutable logical resource descriptor. */
export function createFrameResource(id: number, name: string): FrameResource {
  if (!Number.isSafeInteger(id) || id < 0) {
    throw new RangeError("Frame resource IDs must be non-negative safe integers.");
  }
  if (name.length === 0) throw new Error("Frame resources require a name.");
  return Object.freeze({ id, name });
}
