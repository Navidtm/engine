import type { FrameResource } from "./resource.js";

/** One declarative frame-graph pass. */
export interface FramePass<Context> {
  /** Unique non-empty name used by explicit `after` dependencies. */
  readonly name: string;
  /** Resources read by this pass. */
  readonly reads?: readonly FrameResource[];
  /** Resources written by this pass. */
  readonly writes?: readonly FrameResource[];
  /** Named passes that must execute before this pass. */
  readonly after?: readonly string[];
  /** Work executed after graph compilation establishes a safe order. */
  readonly execute: (context: Context) => void;
}

/** Validates a pass descriptor for use in a frame graph. */
export function defineFramePass<Context>(pass: FramePass<Context>): FramePass<Context> {
  if (pass.name.length === 0) throw new Error("Frame passes require a name.");
  return pass;
}
