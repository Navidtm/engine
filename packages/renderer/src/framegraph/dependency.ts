import type { FramePass } from "./pass.js";
import type { FrameResource } from "./resource.js";

/** Directed dependency lists indexed by frame-pass position. */
export interface PassDependencies {
  /** Pass indices that must execute before each pass. */
  readonly incoming: readonly (readonly number[])[];
  /** Pass indices that become eligible after each pass completes. */
  readonly outgoing: readonly (readonly number[])[];
}

/** Infers execution dependencies from explicit pass names and resource hazards. */
export function buildPassDependencies<Context>(
  resources: readonly FrameResource[],
  passes: readonly FramePass<Context>[],
): PassDependencies {
  const incoming = Array.from({ length: passes.length }, () => new Set<number>());
  const outgoing = Array.from({ length: passes.length }, () => new Set<number>());
  const passByName = new Map<string, number>();
  const lastWriter = new Int32Array(resources.length).fill(-1);
  const readers = Array.from({ length: resources.length }, () => new Set<number>());

  for (let index = 0; index < passes.length; index += 1) {
    const pass = passes[index];
    if (pass === undefined) continue;
    if (passByName.has(pass.name)) throw new Error(`Duplicate frame pass '${pass.name}'.`);
    passByName.set(pass.name, index);
  }

  for (let index = 0; index < passes.length; index += 1) {
    const pass = passes[index];
    if (pass === undefined) continue;
    for (const dependencyName of pass.after ?? []) {
      const dependency = passByName.get(dependencyName);
      if (dependency === undefined) {
        throw new Error(`Frame pass '${pass.name}' depends on unknown pass '${dependencyName}'.`);
      }
      addDependency(dependency, index, incoming, outgoing);
    }
    for (const resource of pass.reads ?? []) {
      validateResource(resources, resource, pass.name);
      const writer = lastWriter[resource.id] ?? -1;
      if (writer >= 0) addDependency(writer, index, incoming, outgoing);
      readers[resource.id]?.add(index);
    }
    for (const resource of pass.writes ?? []) {
      validateResource(resources, resource, pass.name);
      const writer = lastWriter[resource.id] ?? -1;
      if (writer >= 0) addDependency(writer, index, incoming, outgoing);
      for (const reader of readers[resource.id] ?? []) {
        addDependency(reader, index, incoming, outgoing);
      }
      readers[resource.id]?.clear();
      lastWriter[resource.id] = index;
    }
  }

  return {
    incoming: incoming.map((dependencies) => [...dependencies] as readonly number[]),
    outgoing: outgoing.map((dependents) => [...dependents] as readonly number[]),
  } satisfies PassDependencies;
}

function validateResource(
  resources: readonly FrameResource[],
  resource: FrameResource,
  passName: string,
): void {
  if (resources[resource.id] !== resource) {
    throw new Error(
      `Frame pass '${passName}' references unregistered resource '${resource.name}'.`,
    );
  }
}

function addDependency(
  dependency: number,
  dependent: number,
  incoming: readonly Set<number>[],
  outgoing: readonly Set<number>[],
): void {
  if (dependency === dependent) return;
  incoming[dependent]?.add(dependency);
  outgoing[dependency]?.add(dependent);
}
