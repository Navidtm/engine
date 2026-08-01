import type { FrameResource } from "./resource.js";

export interface FramePass<Context> {
  readonly name: string;
  readonly reads?: readonly FrameResource[];
  readonly writes?: readonly FrameResource[];
  readonly after?: readonly string[];
  readonly execute: (context: Context) => void;
}

export function defineFramePass<Context>(pass: FramePass<Context>): FramePass<Context> {
  if (pass.name.length === 0) throw new Error("Frame passes require a name.");
  return Object.freeze(pass);
}
