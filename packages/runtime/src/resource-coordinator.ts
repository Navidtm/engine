import type { MeshRenderer } from "@lume/renderer";

import type { RuntimeCommand } from "./protocol.js";
import type { WasmCore } from "./wasm.js";

const INDEX_MASK = 0x000f_ffff;
const GENERATION_MASK = 0x0fff;

const enum ResourceStatus {
  Empty = 0,
  Ready = 1,
  Retired = 2,
}

interface RegistryState {
  readonly status: Uint8Array;
  readonly generation: Uint16Array;
  readonly usage: Uint32Array;
}

/** Canonical worker owner for logical resources and ECS usage edges. */
export interface ResourceCoordinator {
  apply(command: RuntimeCommand, core: WasmCore, renderer: MeshRenderer, aspect: number): void;
  dispose(core: WasmCore, renderer: MeshRenderer): void;
}

/** Creates fixed-capacity coordinator storage; no lifecycle work runs in the frame path. */
export function createResourceCoordinator(
  resourceCapacity: number,
  entityCapacity = resourceCapacity,
): ResourceCoordinator {
  const geometry = createRegistry(resourceCapacity);
  const materials = createRegistry(resourceCapacity);
  const entityGenerations = new Uint16Array(entityCapacity);
  const entityAlive = new Uint8Array(entityCapacity);
  const meshGeometry = new Uint32Array(entityCapacity);
  const meshMaterial = new Uint32Array(entityCapacity);
  let disposed = false;

  const releaseMesh = (entityIndex: number, core: WasmCore, renderer: MeshRenderer): void => {
    const geometryRaw = meshGeometry[entityIndex] ?? 0;
    const materialRaw = meshMaterial[entityIndex] ?? 0;
    meshGeometry[entityIndex] = 0;
    meshMaterial[entityIndex] = 0;
    releaseUsage(geometry, geometryRaw, () => renderer.removeGeometry(geometryRaw));
    releaseUsage(materials, materialRaw, () => {
      core.removeBasicMaterial(materialRaw);
      renderer.removeBasicMaterial(materialRaw);
    });
  };

  return {
    apply(command, core, renderer, aspect) {
      if (disposed) throw new Error("Resource coordinator is disposed.");
      switch (command.type) {
        case "create-geometry": {
          preflightCreate(geometry, command.handle);
          renderer.registerGeometry(command.handle, command.builtin);
          commitCreate(geometry, command.handle);
          return;
        }
        case "create-basic-material": {
          preflightCreate(materials, command.handle);
          renderer.registerBasicMaterial(command.handle);
          try {
            core.createBasicMaterial(command.handle, command.color);
          } catch (error) {
            renderer.removeBasicMaterial(command.handle);
            throw error;
          }
          commitCreate(materials, command.handle);
          return;
        }
        case "retire-resource": {
          const registry = command.resourceKind === "geometry" ? geometry : materials;
          const index = validateRecord(registry, command.handle, true);
          if (registry.status[index] === ResourceStatus.Retired) return;
          registry.status[index] = ResourceStatus.Retired;
          finalizeIfUnused(registry, command.handle, () => {
            if (command.resourceKind === "geometry") renderer.removeGeometry(command.handle);
            else {
              core.removeBasicMaterial(command.handle);
              renderer.removeBasicMaterial(command.handle);
            }
          });
          return;
        }
        case "spawn": {
          core.apply(command, aspect);
          const index = entityIndex(command.entity);
          entityGenerations[index] = entityGeneration(command.entity);
          entityAlive[index] = 1;
          return;
        }
        case "despawn": {
          validateEntity(command.entity, entityAlive, entityGenerations);
          core.apply(command, aspect);
          const index = entityIndex(command.entity);
          releaseMesh(index, core, renderer);
          entityAlive[index] = 0;
          entityGenerations[index] = ((entityGenerations[index] ?? 0) + 1) & GENERATION_MASK;
          return;
        }
        case "add-mesh": {
          const index = validateEntity(command.entity, entityAlive, entityGenerations);
          const previousGeometry = meshGeometry[index] ?? 0;
          const previousMaterial = meshMaterial[index] ?? 0;
          validateUsage(geometry, command.geometry, previousGeometry);
          validateUsage(materials, command.material, previousMaterial);
          core.apply(command, aspect);
          replaceUsage(geometry, previousGeometry, command.geometry, () =>
            renderer.removeGeometry(previousGeometry),
          );
          replaceUsage(materials, previousMaterial, command.material, () => {
            core.removeBasicMaterial(previousMaterial);
            renderer.removeBasicMaterial(previousMaterial);
          });
          meshGeometry[index] = command.geometry;
          meshMaterial[index] = command.material;
          return;
        }
        case "remove-component": {
          validateEntity(command.entity, entityAlive, entityGenerations);
          core.apply(command, aspect);
          if (command.component === "mesh") {
            releaseMesh(entityIndex(command.entity), core, renderer);
          }
          return;
        }
        case "add-transform":
        case "add-camera":
        case "add-bounds":
          validateEntity(command.entity, entityAlive, entityGenerations);
          core.apply(command, aspect);
          return;
      }
    },
    dispose(core, renderer) {
      if (disposed) return;
      disposed = true;
      for (let index = 1; index < resourceCapacity; index += 1) {
        if (geometry.status[index] !== ResourceStatus.Empty) {
          renderer.removeGeometry(pack(index, geometry.generation[index] ?? 0));
        }
        if (materials.status[index] !== ResourceStatus.Empty) {
          const handle = pack(index, materials.generation[index] ?? 0);
          core.removeBasicMaterial(handle);
          renderer.removeBasicMaterial(handle);
        }
      }
      geometry.status.fill(ResourceStatus.Empty);
      materials.status.fill(ResourceStatus.Empty);
      entityAlive.fill(0);
      meshGeometry.fill(0);
      meshMaterial.fill(0);
    },
  };
}

function createRegistry(capacity: number): RegistryState {
  return {
    status: new Uint8Array(capacity),
    generation: new Uint16Array(capacity),
    usage: new Uint32Array(capacity),
  };
}

function preflightCreate(registry: RegistryState, handle: number): void {
  const index = resourceIndex(handle);
  if (
    index <= 0 ||
    index >= registry.status.length ||
    registry.status[index] !== ResourceStatus.Empty ||
    registry.generation[index] !== resourceGeneration(handle)
  ) {
    throw new Error(`Invalid, stale, or occupied resource handle: ${handle}`);
  }
}

function commitCreate(registry: RegistryState, handle: number): void {
  registry.status[resourceIndex(handle)] = ResourceStatus.Ready;
}

function validateUsage(registry: RegistryState, handle: number, existing: number): void {
  const index = validateRecord(registry, handle, existing === handle);
  if (registry.status[index] !== ResourceStatus.Ready && existing !== handle) {
    throw new Error(`Resource handle is retired: ${handle}`);
  }
}

function validateRecord(registry: RegistryState, handle: number, allowRetired: boolean): number {
  const index = resourceIndex(handle);
  const status = registry.status[index];
  if (
    index <= 0 ||
    index >= registry.status.length ||
    registry.generation[index] !== resourceGeneration(handle) ||
    status === ResourceStatus.Empty ||
    (!allowRetired && status === ResourceStatus.Retired)
  ) {
    throw new Error(`Invalid, stale, or retired resource handle: ${handle}`);
  }
  return index;
}

function replaceUsage(
  registry: RegistryState,
  previous: number,
  next: number,
  finalizePrevious: () => void,
): void {
  if (previous === next) return;
  const nextIndex = resourceIndex(next);
  registry.usage[nextIndex] = (registry.usage[nextIndex] ?? 0) + 1;
  releaseUsage(registry, previous, finalizePrevious);
}

function releaseUsage(registry: RegistryState, handle: number, finalize: () => void): void {
  if (handle === 0) return;
  const index = resourceIndex(handle);
  const count = registry.usage[index] ?? 0;
  if (count === 0) throw new Error("Resource coordinator usage underflow.");
  registry.usage[index] = count - 1;
  finalizeIfUnused(registry, handle, finalize);
}

function finalizeIfUnused(registry: RegistryState, handle: number, finalize: () => void): void {
  const index = resourceIndex(handle);
  if (registry.status[index] !== ResourceStatus.Retired || registry.usage[index] !== 0) return;
  finalize();
  registry.status[index] = ResourceStatus.Empty;
  registry.generation[index] = ((registry.generation[index] ?? 0) + 1) & GENERATION_MASK;
}

function validateEntity(raw: number, alive: Uint8Array, generations: Uint16Array): number {
  const index = entityIndex(raw);
  if (
    index <= 0 ||
    index >= alive.length ||
    alive[index] === 0 ||
    generations[index] !== entityGeneration(raw)
  ) {
    throw new Error(`Invalid or stale entity handle: ${raw}`);
  }
  return index;
}

function resourceIndex(raw: number): number {
  return raw & INDEX_MASK;
}

function resourceGeneration(raw: number): number {
  return raw >>> 20;
}

function entityIndex(raw: number): number {
  return raw & INDEX_MASK;
}

function entityGeneration(raw: number): number {
  return raw >>> 20;
}

function pack(index: number, generation: number): number {
  return (generation << 20) | index;
}
