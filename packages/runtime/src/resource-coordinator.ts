import { AssetError, type DecodedGeometry } from "@lume/assets";
import type { MeshRenderer } from "@lume/renderer";

import { defineRuntimeGeometryLimits, type RuntimeGeometryLimits } from "./geometry-limits.js";
import type { GeometryAssetStats, RuntimeCommand } from "./protocol.js";
import type { WasmCore } from "./wasm.js";

const INDEX_MASK = 0x000f_ffff;
const GENERATION_MASK = 0x0fff;
const TRIANGLE_GPU_BYTES =
  3 * 6 * Float32Array.BYTES_PER_ELEMENT + 3 * Uint32Array.BYTES_PER_ELEMENT;
const CUBE_GPU_BYTES = 24 * 6 * Float32Array.BYTES_PER_ELEMENT + 36 * Uint32Array.BYTES_PER_ELEMENT;

const enum ResourceStatus {
  Empty = 0,
  Loading = 1,
  Ready = 2,
  Retired = 3,
}

const enum GeometryKind {
  None = 0,
  Triangle = 1,
  Cube = 2,
  External = 3,
}

interface RegistryState {
  readonly status: Uint8Array;
  readonly generation: Uint16Array;
  readonly usage: Uint32Array;
}

/** Identity and cancellation signal for one worker-owned async load attempt. */
export interface GeometryLoadAttempt {
  readonly requestId: number;
  readonly handle: number;
  readonly epoch: number;
  readonly signal: AbortSignal;
}

interface MutableGeometryLoadAttempt extends GeometryLoadAttempt {
  readonly controller: AbortController;
  temporaryBytes: number;
  encodedBytes: number;
  cancelled: boolean;
  finalized: boolean;
}

/** Canonical worker owner for logical resources and ECS usage edges. */
export interface ResourceCoordinator {
  apply(command: RuntimeCommand, core: WasmCore, renderer: MeshRenderer, aspect: number): void;
  beginGeometryLoad(requestId: number, handle: number): GeometryLoadAttempt;
  prepareGeometryDecode(attempt: GeometryLoadAttempt, encodedBytes: number): void;
  isGeometryLoadCurrent(attempt: GeometryLoadAttempt): boolean;
  commitGeometryLoad(
    attempt: GeometryLoadAttempt,
    descriptor: DecodedGeometry,
    renderer: MeshRenderer,
  ): void;
  abortGeometryLoad(requestId: number): boolean;
  abortAllGeometryLoads(): void;
  rollbackGeometryLoad(attempt: GeometryLoadAttempt, aborted: boolean): void;
  assetStats(): GeometryAssetStats;
  /** Recreates all live renderer-owned resources after device loss. */
  rebuildRenderer(renderer: MeshRenderer): void;
  dispose(core: WasmCore, renderer: MeshRenderer | undefined): void;
}

/** Creates fixed-capacity coordinator storage; no lifecycle work runs in the frame path. */
export function createResourceCoordinator(
  resourceCapacity: number,
  entityCapacity = resourceCapacity,
  requestedGeometryLimits?: RuntimeGeometryLimits,
): ResourceCoordinator {
  const geometryLimits =
    requestedGeometryLimits === undefined
      ? undefined
      : defineRuntimeGeometryLimits(requestedGeometryLimits);
  const geometry = createRegistry(resourceCapacity);
  const materials = createRegistry(resourceCapacity);
  const entityGenerations = new Uint16Array(entityCapacity);
  const entityAlive = new Uint8Array(entityCapacity);
  const meshGeometry = new Uint32Array(entityCapacity);
  const meshMaterial = new Uint32Array(entityCapacity);
  const geometryKind = new Uint8Array(resourceCapacity);
  const geometryDecodedBytes = new Float64Array(resourceCapacity);
  const geometryGpuBytes = new Float64Array(resourceCapacity);
  const geometryDescriptors: Array<DecodedGeometry | undefined> = new Array(resourceCapacity);
  const geometryLoadEpochs = new Float64Array(resourceCapacity);
  const geometryAttempts: Array<MutableGeometryLoadAttempt | undefined> = new Array(
    resourceCapacity,
  );
  const geometryRequests = new Map<number, MutableGeometryLoadAttempt>();
  let pendingLoads = 0;
  let successfulLoads = 0;
  let failedLoads = 0;
  let abortedLoads = 0;
  let fetchedEncodedBytes = 0;
  let temporaryReservedBytes = 0;
  let retainedDecodedBytes = 0;
  let residentGpuBytes = 0;
  let disposed = false;

  const finalizeGeometryRecord = (handle: number, renderer: MeshRenderer): void => {
    renderer.removeGeometry(handle);
    const index = resourceIndex(handle);
    retainedDecodedBytes -= geometryDecodedBytes[index] ?? 0;
    residentGpuBytes -= geometryGpuBytes[index] ?? 0;
    geometryDecodedBytes[index] = 0;
    geometryGpuBytes[index] = 0;
    geometryDescriptors[index] = undefined;
    geometryKind[index] = GeometryKind.None;
    commitFinalization(geometry, handle);
  };

  const releaseMesh = (entityIndex: number, core: WasmCore, renderer: MeshRenderer): void => {
    const geometryRaw = meshGeometry[entityIndex] ?? 0;
    const materialRaw = meshMaterial[entityIndex] ?? 0;
    meshGeometry[entityIndex] = 0;
    meshMaterial[entityIndex] = 0;
    if (releaseUsage(geometry, geometryRaw)) {
      finalizeGeometryRecord(geometryRaw, renderer);
    }
    if (releaseUsage(materials, materialRaw)) {
      finalizeBasicMaterial(materials, materialRaw, core, renderer);
    }
  };

  const currentAttempt = (attempt: GeometryLoadAttempt): MutableGeometryLoadAttempt => {
    const index = resourceIndex(attempt.handle);
    const current = geometryAttempts[index];
    if (
      current !== attempt ||
      current.finalized ||
      current.cancelled ||
      geometry.status[index] !== ResourceStatus.Loading ||
      geometryLoadEpochs[index] !== attempt.epoch
    ) {
      throw new AssetError(
        "LUME_ASSET_ABORTED",
        "lifecycle",
        "Geometry load attempt is no longer current.",
      );
    }
    return current;
  };

  const replaceTemporaryReservation = (
    attempt: MutableGeometryLoadAttempt,
    nextBytes: number,
  ): void => {
    const limit = geometryLimits?.maxTemporaryBytes;
    if (limit === undefined) {
      throw new AssetError(
        "LUME_ASSET_BUDGET_EXCEEDED",
        "budget",
        "External geometry loading requires configured runtime budgets.",
      );
    }
    const withoutAttempt = temporaryReservedBytes - attempt.temporaryBytes;
    if (nextBytes > limit - withoutAttempt) {
      throw new AssetError(
        "LUME_ASSET_BUDGET_EXCEEDED",
        "budget",
        "Temporary geometry reservations exceed the configured runtime budget.",
      );
    }
    temporaryReservedBytes = withoutAttempt + nextBytes;
    attempt.temporaryBytes = nextBytes;
  };

  const finishAttempt = (attempt: MutableGeometryLoadAttempt): void => {
    if (attempt.finalized) return;
    attempt.finalized = true;
    temporaryReservedBytes -= attempt.temporaryBytes;
    attempt.temporaryBytes = 0;
    pendingLoads -= 1;
    geometryRequests.delete(attempt.requestId);
    const index = resourceIndex(attempt.handle);
    if (geometryAttempts[index] === attempt) geometryAttempts[index] = undefined;
  };

  return {
    apply(command, core, renderer, aspect) {
      if (disposed) throw new Error("Resource coordinator is disposed.");
      switch (command.type) {
        case "create-geometry": {
          preflightCreate(geometry, command.handle);
          const gpuBytes = command.builtin === "triangle" ? TRIANGLE_GPU_BYTES : CUBE_GPU_BYTES;
          assertResidentGpuBudget(geometryLimits, residentGpuBytes, gpuBytes);
          renderer.registerGeometry(command.handle, command.builtin);
          commitCreate(geometry, command.handle);
          const index = resourceIndex(command.handle);
          geometryKind[index] =
            command.builtin === "triangle" ? GeometryKind.Triangle : GeometryKind.Cube;
          geometryGpuBytes[index] = gpuBytes;
          residentGpuBytes += gpuBytes;
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
          if (registry.status[index] === ResourceStatus.Loading) {
            throw new Error(`Cannot retire a loading resource handle: ${command.handle}`);
          }
          if (registry.status[index] === ResourceStatus.Retired) return;
          registry.status[index] = ResourceStatus.Retired;
          if (!isUnusedRetired(registry, command.handle)) return;
          if (command.resourceKind === "geometry") {
            finalizeGeometryRecord(command.handle, renderer);
          } else {
            finalizeBasicMaterial(registry, command.handle, core, renderer);
          }
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
          const generation = entityGenerations[index] ?? 0;
          if (generation < GENERATION_MASK) entityGenerations[index] = generation + 1;
          return;
        }
        case "add-mesh": {
          const index = validateEntity(command.entity, entityAlive, entityGenerations);
          const previousGeometry = meshGeometry[index] ?? 0;
          const previousMaterial = meshMaterial[index] ?? 0;
          validateUsage(geometry, command.geometry, previousGeometry);
          validateUsage(materials, command.material, previousMaterial);
          core.apply(command, aspect);
          if (replaceUsage(geometry, previousGeometry, command.geometry)) {
            finalizeGeometryRecord(previousGeometry, renderer);
          }
          if (replaceUsage(materials, previousMaterial, command.material)) {
            finalizeBasicMaterial(materials, previousMaterial, core, renderer);
          }
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
    beginGeometryLoad(requestId, handle) {
      if (disposed) {
        throw new AssetError(
          "LUME_ASSET_ABORTED",
          "lifecycle",
          "Resource coordinator is disposed.",
        );
      }
      if (!Number.isSafeInteger(requestId) || requestId <= 0) {
        throw new AssetError(
          "LUME_ASSET_FORMAT",
          "request",
          "Geometry requestId must be a positive safe integer.",
        );
      }
      if (geometryRequests.has(requestId)) {
        throw new AssetError(
          "LUME_ASSET_FORMAT",
          "request",
          "Geometry requestId is already active.",
        );
      }
      try {
        preflightCreate(geometry, handle);
      } catch {
        throw new AssetError(
          "LUME_ASSET_CAPACITY_EXHAUSTED",
          "request",
          "Reserved geometry identity is stale, occupied, or outside capacity.",
        );
      }
      const limits = geometryLimits;
      if (limits === undefined) {
        throw new AssetError(
          "LUME_ASSET_BUDGET_EXCEEDED",
          "budget",
          "External geometry loading requires configured runtime budgets.",
        );
      }
      const initialReservation = checkedSafeAdd(
        limits.decode.maxEncodedBytes,
        limits.decode.maxEncodedBytes,
        "download reservation",
      );
      const index = resourceIndex(handle);
      const previousEpoch = geometryLoadEpochs[index] ?? 0;
      if (previousEpoch >= Number.MAX_SAFE_INTEGER) {
        throw new AssetError(
          "LUME_ASSET_CAPACITY_EXHAUSTED",
          "lifecycle",
          "Geometry load-attempt epoch is exhausted.",
        );
      }
      const controller = new AbortController();
      const attempt: MutableGeometryLoadAttempt = {
        requestId,
        handle,
        epoch: previousEpoch + 1,
        signal: controller.signal,
        controller,
        temporaryBytes: 0,
        encodedBytes: 0,
        cancelled: false,
        finalized: false,
      };
      replaceTemporaryReservation(attempt, initialReservation);
      geometryLoadEpochs[index] = attempt.epoch;
      geometry.status[index] = ResourceStatus.Loading;
      geometryAttempts[index] = attempt;
      geometryRequests.set(requestId, attempt);
      pendingLoads += 1;
      return attempt;
    },
    prepareGeometryDecode(attempt, encodedBytes) {
      const current = currentAttempt(attempt);
      const limits = geometryLimits;
      if (limits === undefined) throw new Error("Geometry budget invariant violated.");
      if (
        !Number.isSafeInteger(encodedBytes) ||
        encodedBytes <= 0 ||
        encodedBytes > limits.decode.maxEncodedBytes
      ) {
        throw new AssetError(
          "LUME_ASSET_BUDGET_EXCEEDED",
          "budget",
          "Fetched geometry bytes exceed the configured request limit.",
        );
      }
      if (current.encodedBytes !== 0) {
        throw new Error("Geometry decode reservation was already prepared.");
      }
      current.encodedBytes = encodedBytes;
      fetchedEncodedBytes += encodedBytes;
      replaceTemporaryReservation(
        current,
        checkedSafeAdd(encodedBytes, limits.decode.maxDecodedBytes, "decode reservation"),
      );
    },
    isGeometryLoadCurrent(attempt) {
      try {
        currentAttempt(attempt);
        return true;
      } catch {
        return false;
      }
    },
    commitGeometryLoad(attempt, descriptor, renderer) {
      const current = currentAttempt(attempt);
      validateDecodedDescriptor(descriptor, current.encodedBytes, geometryLimits);
      const decodedBytes = descriptor.bytes.decodedBytes;
      if (
        geometryLimits !== undefined &&
        decodedBytes > geometryLimits.maxRetainedDecodedBytes - retainedDecodedBytes
      ) {
        throw new AssetError(
          "LUME_ASSET_BUDGET_EXCEEDED",
          "budget",
          "Retained decoded geometry exceeds the configured runtime budget.",
        );
      }
      assertResidentGpuBudget(geometryLimits, residentGpuBytes, decodedBytes);
      renderer.registerExternalGeometry(attempt.handle, descriptor);
      try {
        currentAttempt(attempt);
      } catch (error) {
        renderer.removeGeometry(attempt.handle);
        throw error;
      }

      const index = resourceIndex(attempt.handle);
      geometryDescriptors[index] = descriptor;
      geometryKind[index] = GeometryKind.External;
      geometryDecodedBytes[index] = decodedBytes;
      geometryGpuBytes[index] = decodedBytes;
      retainedDecodedBytes += decodedBytes;
      residentGpuBytes += decodedBytes;
      geometry.status[index] = ResourceStatus.Ready;
      successfulLoads += 1;
      finishAttempt(current);
    },
    abortGeometryLoad(requestId) {
      const attempt = geometryRequests.get(requestId);
      if (attempt === undefined || attempt.finalized || attempt.cancelled) return false;
      attempt.cancelled = true;
      const index = resourceIndex(attempt.handle);
      const epoch = geometryLoadEpochs[index] ?? attempt.epoch;
      geometryLoadEpochs[index] = epoch < Number.MAX_SAFE_INTEGER ? epoch + 1 : epoch;
      attempt.controller.abort();
      return true;
    },
    abortAllGeometryLoads() {
      for (const attempt of geometryRequests.values()) {
        if (attempt.finalized || attempt.cancelled) continue;
        attempt.cancelled = true;
        const index = resourceIndex(attempt.handle);
        const epoch = geometryLoadEpochs[index] ?? attempt.epoch;
        geometryLoadEpochs[index] = epoch < Number.MAX_SAFE_INTEGER ? epoch + 1 : epoch;
        attempt.controller.abort();
      }
    },
    rollbackGeometryLoad(attempt, aborted) {
      const index = resourceIndex(attempt.handle);
      const current = geometryAttempts[index];
      if (current !== attempt || current.finalized) return;
      finishAttempt(current);
      geometry.status[index] = ResourceStatus.Empty;
      geometryKind[index] = GeometryKind.None;
      geometryDescriptors[index] = undefined;
      if (aborted || current.cancelled) abortedLoads += 1;
      else failedLoads += 1;
      const generation = geometry.generation[index] ?? 0;
      geometry.generation[index] =
        generation < GENERATION_MASK ? generation + 1 : GENERATION_MASK + 1;
    },
    assetStats() {
      return {
        pendingLoads,
        successfulLoads,
        failedLoads,
        abortedLoads,
        fetchedEncodedBytes,
        temporaryReservedBytes,
        retainedDecodedBytes,
        residentGpuBytes,
      };
    },
    rebuildRenderer(renderer) {
      if (disposed) throw new Error("Resource coordinator is disposed.");
      for (let index = 1; index < resourceCapacity; index += 1) {
        const geometryStatus = geometry.status[index];
        if (geometryStatus === ResourceStatus.Ready || geometryStatus === ResourceStatus.Retired) {
          const handle = pack(index, geometry.generation[index] ?? 0);
          const kind = geometryKind[index];
          if (kind === GeometryKind.Triangle || kind === GeometryKind.Cube) {
            renderer.registerGeometry(handle, kind === GeometryKind.Triangle ? "triangle" : "cube");
          } else if (kind === GeometryKind.External) {
            const descriptor = geometryDescriptors[index];
            if (descriptor === undefined) {
              throw new Error(`Missing replay descriptor for geometry handle: ${handle}`);
            }
            renderer.registerExternalGeometry(handle, descriptor);
          } else {
            throw new Error(`Missing geometry kind for live handle: ${handle}`);
          }
        }
        if (materials.status[index] !== ResourceStatus.Empty) {
          renderer.registerBasicMaterial(pack(index, materials.generation[index] ?? 0));
        }
      }
    },
    dispose(core, renderer) {
      if (disposed) return;
      disposed = true;
      for (const attempt of geometryRequests.values()) {
        attempt.cancelled = true;
        attempt.controller.abort();
        const index = resourceIndex(attempt.handle);
        finishAttempt(attempt);
        geometry.status[index] = ResourceStatus.Empty;
        const generation = geometry.generation[index] ?? 0;
        geometry.generation[index] =
          generation < GENERATION_MASK ? generation + 1 : GENERATION_MASK + 1;
        abortedLoads += 1;
      }
      for (let index = 1; index < resourceCapacity; index += 1) {
        const geometryStatus = geometry.status[index];
        if (
          renderer !== undefined &&
          (geometryStatus === ResourceStatus.Ready || geometryStatus === ResourceStatus.Retired)
        ) {
          renderer.removeGeometry(pack(index, geometry.generation[index] ?? 0));
        }
        if (materials.status[index] !== ResourceStatus.Empty) {
          const handle = pack(index, materials.generation[index] ?? 0);
          core.removeBasicMaterial(handle);
          renderer?.removeBasicMaterial(handle);
        }
      }
      geometry.status.fill(ResourceStatus.Empty);
      materials.status.fill(ResourceStatus.Empty);
      entityAlive.fill(0);
      meshGeometry.fill(0);
      meshMaterial.fill(0);
      geometryKind.fill(GeometryKind.None);
      geometryDecodedBytes.fill(0);
      geometryGpuBytes.fill(0);
      geometryDescriptors.fill(undefined);
      geometryAttempts.fill(undefined);
      geometryRequests.clear();
      temporaryReservedBytes = 0;
      retainedDecodedBytes = 0;
      residentGpuBytes = 0;
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

function replaceUsage(registry: RegistryState, previous: number, next: number): boolean {
  if (previous === next) return false;
  const nextIndex = resourceIndex(next);
  registry.usage[nextIndex] = (registry.usage[nextIndex] ?? 0) + 1;
  return releaseUsage(registry, previous);
}

function releaseUsage(registry: RegistryState, handle: number): boolean {
  if (handle === 0) return false;
  const index = resourceIndex(handle);
  const count = registry.usage[index] ?? 0;
  if (count === 0) throw new Error("Resource coordinator usage underflow.");
  registry.usage[index] = count - 1;
  return isUnusedRetired(registry, handle);
}

function isUnusedRetired(registry: RegistryState, handle: number): boolean {
  const index = resourceIndex(handle);
  return registry.status[index] === ResourceStatus.Retired && registry.usage[index] === 0;
}

function finalizeBasicMaterial(
  registry: RegistryState,
  handle: number,
  core: WasmCore,
  renderer: MeshRenderer,
): void {
  core.removeBasicMaterial(handle);
  renderer.removeBasicMaterial(handle);
  commitFinalization(registry, handle);
}

function commitFinalization(registry: RegistryState, handle: number): void {
  const index = resourceIndex(handle);
  registry.status[index] = ResourceStatus.Empty;
  const generation = registry.generation[index] ?? 0;
  registry.generation[index] = generation < GENERATION_MASK ? generation + 1 : GENERATION_MASK + 1;
}

function validateEntity(raw: number, alive: Uint8Array, generations: Uint16Array): number {
  const index = entityIndex(raw);
  if (index >= alive.length || alive[index] === 0 || generations[index] !== entityGeneration(raw)) {
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

function validateDecodedDescriptor(
  descriptor: DecodedGeometry,
  encodedBytes: number,
  limits: Readonly<RuntimeGeometryLimits> | undefined,
): void {
  if (limits === undefined) throw new Error("Geometry budget invariant violated.");
  const vertexValues = checkedSafeMultiply(descriptor.vertexCount, 6, "vertex value count");
  const vertexBytes = checkedSafeMultiply(
    vertexValues,
    Float32Array.BYTES_PER_ELEMENT,
    "vertex bytes",
  );
  const indexBytes = checkedSafeMultiply(
    descriptor.indexCount,
    Uint32Array.BYTES_PER_ELEMENT,
    "index bytes",
  );
  const decodedBytes = checkedSafeAdd(vertexBytes, indexBytes, "decoded bytes");
  if (
    descriptor.bytes.encodedBytes !== encodedBytes ||
    descriptor.interleavedVertices.length !== vertexValues ||
    descriptor.indices.length !== descriptor.indexCount ||
    descriptor.interleavedVertices.byteLength !== vertexBytes ||
    descriptor.indices.byteLength !== indexBytes ||
    descriptor.bytes.vertexBytes !== vertexBytes ||
    descriptor.bytes.indexBytes !== indexBytes ||
    descriptor.bytes.decodedBytes !== decodedBytes ||
    descriptor.vertexCount > limits.decode.maxVertices ||
    descriptor.indexCount > limits.decode.maxIndices ||
    decodedBytes > limits.decode.maxDecodedBytes
  ) {
    throw new AssetError(
      "LUME_ASSET_FORMAT",
      "geometry",
      "Decoded geometry descriptor does not match its validated accounting.",
    );
  }
}

function assertResidentGpuBudget(
  limits: Readonly<RuntimeGeometryLimits> | undefined,
  residentBytes: number,
  requestedBytes: number,
): void {
  if (limits !== undefined && requestedBytes > limits.maxResidentGpuBytes - residentBytes) {
    throw new AssetError(
      "LUME_ASSET_BUDGET_EXCEEDED",
      "budget",
      "Resident geometry buffers exceed the configured GPU budget.",
    );
  }
}

function checkedSafeAdd(left: number, right: number, label: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AssetError(
      "LUME_ASSET_BUDGET_EXCEEDED",
      "budget",
      `${label} exceeds safe integer accounting.`,
    );
  }
  return value;
}

function checkedSafeMultiply(left: number, right: number, label: string): number {
  const value = left * right;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AssetError(
      "LUME_ASSET_BUDGET_EXCEEDED",
      "budget",
      `${label} exceeds safe integer accounting.`,
    );
  }
  return value;
}
