import { buildPassDependencies } from "./dependency.js";
import type { FramePass } from "./pass.js";
import { createFrameResource, type FrameResource } from "./resource.js";

/** Mutable graph declaration, valid only until it is compiled once. */
export interface FrameGraph<Context> {
  /** Registered logical resources in creation order. */
  readonly resources: FrameResource[];
  /** Registered declarative passes in insertion order. */
  readonly passes: FramePass<Context>[];
  /** Internal lifecycle flag; `true` prevents further graph mutation. */
  compiled: boolean;
}

/** Immutable execution order generated from a frame graph. */
export interface CompiledFrameGraph<Context> {
  /** Topologically sorted passes ready for execution. */
  readonly orderedPasses: readonly FramePass<Context>[];
}

/** Starts an empty, mutable frame graph. */
export function createFrameGraph<Context>(): FrameGraph<Context> {
  return { resources: [], passes: [], compiled: false };
}

/** Registers a logical resource and returns its graph-local identity. */
export function addFrameResource<Context>(graph: FrameGraph<Context>, name: string): FrameResource {
  assertMutable(graph);
  const resource = createFrameResource(graph.resources.length, name);
  graph.resources.push(resource);
  return resource;
}

/** Registers a previously validated pass before graph compilation. */
export function addFramePass<Context>(graph: FrameGraph<Context>, pass: FramePass<Context>): void {
  assertMutable(graph);
  graph.passes.push(pass);
}

/** Freezes a graph and returns its dependency-safe pass order. */
export function compileFrameGraph<Context>(
  graph: FrameGraph<Context>,
): CompiledFrameGraph<Context> {
  assertMutable(graph);
  graph.compiled = true;
  const dependencies = buildPassDependencies(graph.resources, graph.passes);
  const remaining = dependencies.incoming.map((incoming) => incoming.length);
  const ready: number[] = [];
  for (let index = 0; index < remaining.length; index += 1) {
    if (remaining[index] === 0) ready.push(index);
  }
  const ordered: FramePass<Context>[] = [];
  let cursor = 0;
  while (cursor < ready.length) {
    const passIndex = ready[cursor];
    cursor += 1;
    if (passIndex === undefined) continue;
    const pass = graph.passes[passIndex];
    if (pass !== undefined) ordered.push(pass);
    for (const dependent of dependencies.outgoing[passIndex] ?? []) {
      const next = (remaining[dependent] ?? 0) - 1;
      remaining[dependent] = next;
      if (next === 0) ready.push(dependent);
    }
  }
  if (ordered.length !== graph.passes.length) {
    throw new Error("Frame graph contains a dependency cycle.");
  }
  return Object.freeze({ orderedPasses: Object.freeze(ordered) });
}

/** Executes each compiled pass synchronously with one shared context value. */
export function executeFrameGraph<Context>(
  graph: CompiledFrameGraph<Context>,
  context: Context,
): void {
  for (let index = 0; index < graph.orderedPasses.length; index += 1) {
    graph.orderedPasses[index]?.execute(context);
  }
}

function assertMutable<Context>(graph: FrameGraph<Context>): void {
  if (graph.compiled) throw new Error("A compiled frame graph cannot be modified.");
}
