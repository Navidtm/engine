export interface FrameResource {
  readonly id: number;
  readonly name: string;
}

export function createFrameResource(id: number, name: string): FrameResource {
  if (!Number.isSafeInteger(id) || id < 0) {
    throw new RangeError("Frame resource IDs must be non-negative safe integers.");
  }
  if (name.length === 0) throw new Error("Frame resources require a name.");
  return Object.freeze({ id, name });
}
