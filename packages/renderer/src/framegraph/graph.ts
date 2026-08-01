import { buildPassDependencies } from "./dependency.js";
import type { FramePass } from "./pass.js";
import { createFrameResource, type FrameResource } from "./resource.js";

export interface FrameGraph<Context> {
  readonly resources: FrameResource[];
  readonly passes: FramePass<Context>[];
  compiled: boolean;
}

export interface CompiledFrameGraph<Context> {
  readonly orderedPasses: readonly FramePass<Context>[];
}

export function createFrameGraph<Context>(): FrameGraph<Context> {
  return { resources: [], passes: [], compiled: false };
}

export function addFrameResource<Context>(graph: FrameGraph<Context>, name: string): FrameResource {
  assertMutable(graph);
  const resource = createFrameResource(graph.resources.length, name);
  graph.resources.push(resource);
  return resource;
}

export function addFramePass<Context>(graph: FrameGraph<Context>, pass: FramePass<Context>): void {
  assertMutable(graph);
  graph.passes.push(pass);
}

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
