import type { RenderFrame } from "@lume/renderer";

import type { RuntimeCommand } from "./protocol.js";
import { SHARED_TRANSFORM_FLOATS, TransformField } from "./shared-memory/layout.js";
import { createSharedCommandDecoder, drainSharedCommands } from "./shared-memory/structural.js";
import { drainSharedTransforms } from "./shared-memory/synchronization.js";
import { openSharedRuntimeViews } from "./shared-memory/views.js";
import { LUME_WASM_ABI_VERSION } from "./wasm-abi.js";

const INSTANCE_FLOATS = 20;
const SLOT_RECORD_WORDS = 4;
const CAMERA_FLOATS = 32;

interface LumeWasmExports extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  lume_abi_version(): number;
  lume_engine_create(
    entityCapacity: number,
    transformCapacity: number,
    resourceCapacity: number,
    meshRendererCapacity: number,
    cameraCapacity: number,
    boundsCapacity: number,
  ): number;
  lume_engine_destroy(engine: number): void;
  lume_engine_spawn(engine: number, entity: number): number;
  lume_engine_despawn(engine: number, entity: number): number;
  lume_engine_add_transform(
    engine: number,
    entity: number,
    px: number,
    py: number,
    pz: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
    sx: number,
    sy: number,
    sz: number,
  ): number;
  lume_transform_update_capacity(engine: number): number;
  lume_transform_update_generations_ptr(engine: number): number;
  lume_transform_update_values_ptr(engine: number): number;
  lume_transform_update_masks_ptr(engine: number): number;
  lume_transform_range_starts_ptr(engine: number): number;
  lume_transform_range_counts_ptr(engine: number): number;
  lume_engine_apply_transform_ranges(engine: number, rangeCount: number): number;
  lume_engine_add_material(
    engine: number,
    handle: number,
    red: number,
    green: number,
    blue: number,
    alpha: number,
  ): number;
  lume_engine_remove_material(engine: number, handle: number): number;
  lume_engine_add_camera(
    engine: number,
    entity: number,
    verticalFov: number,
    near: number,
    far: number,
    aspect: number,
  ): number;
  lume_engine_add_mesh_renderer(
    engine: number,
    entity: number,
    geometry: number,
    material: number,
  ): number;
  lume_engine_add_bounds(
    engine: number,
    entity: number,
    centerX: number,
    centerY: number,
    centerZ: number,
    radius: number,
  ): number;
  lume_engine_remove_component(engine: number, entity: number, component: number): number;
  lume_engine_update(engine: number): number;
  lume_engine_update_systems(engine: number): number;
  lume_engine_extract(engine: number): number;
  lume_engine_update_visibility(engine: number): number;
  lume_engine_set_camera_aspect(engine: number, aspect: number): number;
  lume_engine_invalidate_renderer_cache(engine: number): number;
  lume_engine_entity_count(engine: number): number;
  lume_render_instance_count(engine: number): number;
  lume_render_camera_count(engine: number): number;
  lume_render_cameras_dirty(engine: number): number;
  lume_render_entity_capacity(engine: number): number;
  lume_render_camera_capacity(engine: number): number;
  lume_render_entities_ptr(engine: number): number;
  lume_render_geometries_ptr(engine: number): number;
  lume_render_instances_ptr(engine: number): number;
  lume_render_slot_states_ptr(engine: number): number;
  lume_render_slot_bounds_ptr(engine: number): number;
  lume_render_slot_resources_ptr(engine: number): number;
  lume_render_dirty_range_count(engine: number): number;
  lume_render_dirty_range_starts_ptr(engine: number): number;
  lume_render_dirty_range_counts_ptr(engine: number): number;
  lume_render_state_dirty_range_count(engine: number): number;
  lume_render_state_dirty_range_starts_ptr(engine: number): number;
  lume_render_state_dirty_range_counts_ptr(engine: number): number;
  lume_render_bounds_dirty_range_count(engine: number): number;
  lume_render_bounds_dirty_range_starts_ptr(engine: number): number;
  lume_render_bounds_dirty_range_counts_ptr(engine: number): number;
  lume_render_resource_dirty_range_count(engine: number): number;
  lume_render_resource_dirty_range_starts_ptr(engine: number): number;
  lume_render_resource_dirty_range_counts_ptr(engine: number): number;
  lume_render_cameras_ptr(engine: number): number;
  lume_visible_count(engine: number): number;
  lume_visible_capacity(engine: number): number;
  lume_visible_slots_dirty(engine: number): number;
  lume_visible_geometries_ptr(engine: number): number;
  lume_visible_pipelines_ptr(engine: number): number;
  lume_visible_materials_ptr(engine: number): number;
  lume_visible_slots_ptr(engine: number): number;
  lume_candidate_count(engine: number): number;
  lume_candidate_slots_dirty(engine: number): number;
  lume_candidate_geometries_ptr(engine: number): number;
  lume_candidate_pipelines_ptr(engine: number): number;
  lume_candidate_materials_ptr(engine: number): number;
  lume_candidate_slots_ptr(engine: number): number;
}

/** Low-level counters sampled from one worker-owned WASM core. */
export interface WasmStats {
  /** Number of live ECS entities. */
  readonly entities: number;
  /** Render-world instances before visibility culling. */
  readonly renderInstances: number;
  /** Instances retained by visibility culling. */
  readonly visibleObjects: number;
  /** Transform records applied during the most recent shared-memory update. */
  readonly sharedTransformUpdates: number;
  /** Dirty ranges staged into WASM since creation. */
  readonly dirtyRanges: number;
  /** Field bytes and range descriptors copied into WASM staging since creation. */
  readonly bytesUploaded: number;
  /** Current WebAssembly linear-memory byte length. */
  readonly wasmHeapBytes: number;
}

/** Reused timings written only by an explicitly profiled update. */
export interface WasmFrameTimings {
  systemsCpuTimeMs: number;
  extractionCpuTimeMs: number;
  visibilityCpuTimeMs: number;
}

/** Worker-only façade over the raw WASM ABI. */
export interface WasmCore {
  /** Stable, allocation-free split timings for the most recent sampled update. */
  readonly frameTimings: WasmFrameTimings;
  /** Creates the Rust render mirror for one worker-owned basic material. */
  createBasicMaterial(handle: number, color: readonly [number, number, number, number]): void;
  /** Removes a logically destroyed basic-material mirror. */
  removeBasicMaterial(handle: number): void;
  /** Applies one fallback structural command using the current camera aspect. */
  apply(command: RuntimeCommand, aspect: number): void;
  /** Drains the shared structural SPSC ring when that transport is active. */
  updateSharedCommands(consume: (command: RuntimeCommand) => void): void;
  /** Applies shared transforms published before an ordered fallback command. */
  updateSharedTransforms(): void;
  /** Updates all camera aspects after a valid surface resize. */
  resize(aspect: number): void;
  /** Republishes all renderer-derived buffers after device reconstruction. */
  invalidateRendererCache(): void;
  /** Advances ECS/render stages and returns borrowed render views. */
  update(profileStages?: boolean): RenderFrame;
  /** Returns non-allocating runtime and transport counters. */
  stats(): WasmStats;
  /** Idempotently frees the Rust engine allocation. */
  dispose(): void;
}

/** Instantiates the ABI-matched WASM core and validates fixed transport capacity. */
export async function createWasmCore(
  url: string,
  entityCapacity: number,
  transformCapacity: number,
  sharedMemory?: SharedArrayBuffer,
  resourceCapacity = entityCapacity,
  meshRendererCapacity = entityCapacity,
  cameraCapacity = Math.min(entityCapacity, 8),
  boundsCapacity = entityCapacity,
): Promise<WasmCore> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (cause) {
    throw new Error(
      `Failed to fetch Lume WASM from ${describeUrl(url)}. Check the URL, network access, and the page's CSP connect-src policy.`,
      { cause },
    );
  }
  if (!response.ok) {
    throw new Error(
      `Failed to fetch Lume WASM from ${describeUrl(url)} (${response.status} ${response.statusText}). Verify that the version-matched artifact is deployed at this URL.`,
    );
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    contentType !== undefined &&
    contentType !== "application/wasm" &&
    contentType !== "application/octet-stream"
  ) {
    throw new Error(
      `Lume WASM at ${describeUrl(url)} was served as '${contentType}'. Configure the server to use 'application/wasm'.`,
    );
  }
  let module: WebAssembly.WebAssemblyInstantiatedSource;
  try {
    module = await WebAssembly.instantiate(await response.arrayBuffer(), {});
  } catch (cause) {
    throw new Error(
      `Failed to compile Lume WASM from ${describeUrl(url)}. The artifact may be corrupt or blocked by CSP; allow WebAssembly with script-src 'wasm-unsafe-eval' where required.`,
      { cause },
    );
  }
  const rawExports = module.instance.exports as Record<string, unknown>;
  const abiVersionExport = rawExports["lume_abi_version"];
  const actualAbiVersion =
    typeof abiVersionExport === "function" ? (abiVersionExport() as unknown) : undefined;
  if (actualAbiVersion !== LUME_WASM_ABI_VERSION) {
    throw new Error(
      `Lume WASM ABI mismatch: @lume/runtime expects ${LUME_WASM_ABI_VERSION}, but the artifact reports ${actualAbiVersion ?? "no version"}. Use the artifact shipped with the same @lume/runtime version.`,
    );
  }
  const exports = module.instance.exports as LumeWasmExports;
  const handle = exports.lume_engine_create(
    entityCapacity,
    transformCapacity,
    resourceCapacity,
    meshRendererCapacity,
    cameraCapacity,
    boundsCapacity,
  );
  if (handle === 0) throw new Error("Lume WASM core allocation failed.");
  const visibleCapacity = exports.lume_visible_capacity(handle);
  const renderEntityCapacity = exports.lume_render_entity_capacity(handle);
  const renderCameraCapacity = exports.lume_render_camera_capacity(handle);
  const geometriesPointer = exports.lume_visible_geometries_ptr(handle);
  const pipelinesPointer = exports.lume_visible_pipelines_ptr(handle);
  const materialsPointer = exports.lume_visible_materials_ptr(handle);
  const visibleSlotsPointer = exports.lume_visible_slots_ptr(handle);
  const instancesPointer = exports.lume_render_instances_ptr(handle);
  const slotStatesPointer = exports.lume_render_slot_states_ptr(handle);
  const slotBoundsPointer = exports.lume_render_slot_bounds_ptr(handle);
  const slotResourcesPointer = exports.lume_render_slot_resources_ptr(handle);
  const dirtyRangeStartsPointer = exports.lume_render_dirty_range_starts_ptr(handle);
  const dirtyRangeCountsPointer = exports.lume_render_dirty_range_counts_ptr(handle);
  const stateDirtyRangeStartsPointer = exports.lume_render_state_dirty_range_starts_ptr(handle);
  const stateDirtyRangeCountsPointer = exports.lume_render_state_dirty_range_counts_ptr(handle);
  const boundsDirtyRangeStartsPointer = exports.lume_render_bounds_dirty_range_starts_ptr(handle);
  const boundsDirtyRangeCountsPointer = exports.lume_render_bounds_dirty_range_counts_ptr(handle);
  const resourceDirtyRangeStartsPointer =
    exports.lume_render_resource_dirty_range_starts_ptr(handle);
  const resourceDirtyRangeCountsPointer =
    exports.lume_render_resource_dirty_range_counts_ptr(handle);
  const candidateGeometriesPointer = exports.lume_candidate_geometries_ptr(handle);
  const candidatePipelinesPointer = exports.lume_candidate_pipelines_ptr(handle);
  const candidateMaterialsPointer = exports.lume_candidate_materials_ptr(handle);
  const candidateSlotsPointer = exports.lume_candidate_slots_ptr(handle);
  const camerasPointer = exports.lume_render_cameras_ptr(handle);
  const transformUpdateCapacity = exports.lume_transform_update_capacity(handle);
  const transformUpdateGenerationsPointer = exports.lume_transform_update_generations_ptr(handle);
  const transformUpdateValuesPointer = exports.lume_transform_update_values_ptr(handle);
  const transformUpdateMasksPointer = exports.lume_transform_update_masks_ptr(handle);
  const transformRangeStartsPointer = exports.lume_transform_range_starts_ptr(handle);
  const transformRangeCountsPointer = exports.lume_transform_range_counts_ptr(handle);
  const sharedViews = sharedMemory === undefined ? undefined : openSharedRuntimeViews(sharedMemory);
  if (sharedViews !== undefined && sharedViews.layout.capacity !== transformUpdateCapacity) {
    exports.lume_engine_destroy(handle);
    throw new Error("Shared transform capacity does not match WASM staging capacity.");
  }
  let observedMemory = exports.memory.buffer;
  const frame: RenderFrame = createFrameViews(
    observedMemory,
    visibleCapacity,
    renderEntityCapacity,
    renderCameraCapacity,
    geometriesPointer,
    pipelinesPointer,
    materialsPointer,
    visibleSlotsPointer,
    instancesPointer,
    slotStatesPointer,
    slotBoundsPointer,
    slotResourcesPointer,
    dirtyRangeStartsPointer,
    dirtyRangeCountsPointer,
    stateDirtyRangeStartsPointer,
    stateDirtyRangeCountsPointer,
    boundsDirtyRangeStartsPointer,
    boundsDirtyRangeCountsPointer,
    resourceDirtyRangeStartsPointer,
    resourceDirtyRangeCountsPointer,
    candidateGeometriesPointer,
    candidatePipelinesPointer,
    candidateMaterialsPointer,
    candidateSlotsPointer,
    camerasPointer,
  );
  let transformUpdateGenerations = new Uint32Array(
    observedMemory,
    transformUpdateGenerationsPointer,
    transformUpdateCapacity,
  );
  let transformUpdateValues = new Float32Array(
    observedMemory,
    transformUpdateValuesPointer,
    transformUpdateCapacity * SHARED_TRANSFORM_FLOATS,
  );
  let transformUpdateMasks = new Uint32Array(
    observedMemory,
    transformUpdateMasksPointer,
    transformUpdateCapacity,
  );
  let transformRangeStarts = new Uint32Array(
    observedMemory,
    transformRangeStartsPointer,
    transformUpdateCapacity,
  );
  let transformRangeCounts = new Uint32Array(
    observedMemory,
    transformRangeCountsPointer,
    transformUpdateCapacity,
  );
  const refreshMemoryViews = (): void => {
    const memory = exports.memory.buffer;
    if (memory === observedMemory) return;
    observedMemory = memory;
    const refreshed = createFrameViews(
      observedMemory,
      visibleCapacity,
      renderEntityCapacity,
      renderCameraCapacity,
      geometriesPointer,
      pipelinesPointer,
      materialsPointer,
      visibleSlotsPointer,
      instancesPointer,
      slotStatesPointer,
      slotBoundsPointer,
      slotResourcesPointer,
      dirtyRangeStartsPointer,
      dirtyRangeCountsPointer,
      stateDirtyRangeStartsPointer,
      stateDirtyRangeCountsPointer,
      boundsDirtyRangeStartsPointer,
      boundsDirtyRangeCountsPointer,
      resourceDirtyRangeStartsPointer,
      resourceDirtyRangeCountsPointer,
      candidateGeometriesPointer,
      candidatePipelinesPointer,
      candidateMaterialsPointer,
      candidateSlotsPointer,
      camerasPointer,
    );
    frame.geometries = refreshed.geometries;
    frame.pipelines = refreshed.pipelines;
    frame.materials = refreshed.materials;
    frame.visibleSlots = refreshed.visibleSlots;
    frame.instanceData = refreshed.instanceData;
    frame.slotStates = refreshed.slotStates;
    frame.slotBounds = refreshed.slotBounds;
    frame.slotResources = refreshed.slotResources;
    frame.dirtyRangeStarts = refreshed.dirtyRangeStarts;
    frame.dirtyRangeCounts = refreshed.dirtyRangeCounts;
    frame.stateDirtyRangeStarts = refreshed.stateDirtyRangeStarts;
    frame.stateDirtyRangeCounts = refreshed.stateDirtyRangeCounts;
    frame.boundsDirtyRangeStarts = refreshed.boundsDirtyRangeStarts;
    frame.boundsDirtyRangeCounts = refreshed.boundsDirtyRangeCounts;
    frame.resourceDirtyRangeStarts = refreshed.resourceDirtyRangeStarts;
    frame.resourceDirtyRangeCounts = refreshed.resourceDirtyRangeCounts;
    frame.candidateGeometries = refreshed.candidateGeometries;
    frame.candidatePipelines = refreshed.candidatePipelines;
    frame.candidateMaterials = refreshed.candidateMaterials;
    frame.candidateSlots = refreshed.candidateSlots;
    frame.cameraData = refreshed.cameraData;
    transformUpdateGenerations = new Uint32Array(
      observedMemory,
      transformUpdateGenerationsPointer,
      transformUpdateCapacity,
    );
    transformUpdateValues = new Float32Array(
      observedMemory,
      transformUpdateValuesPointer,
      transformUpdateCapacity * SHARED_TRANSFORM_FLOATS,
    );
    transformUpdateMasks = new Uint32Array(
      observedMemory,
      transformUpdateMasksPointer,
      transformUpdateCapacity,
    );
    transformRangeStarts = new Uint32Array(
      observedMemory,
      transformRangeStartsPointer,
      transformUpdateCapacity,
    );
    transformRangeCounts = new Uint32Array(
      observedMemory,
      transformRangeCountsPointer,
      transformUpdateCapacity,
    );
  };
  const stagedEpochs = new Uint32Array(transformUpdateCapacity);
  const transformScratch = new Float32Array(SHARED_TRANSFORM_FLOATS);
  let stagedTransformCount = 0;
  let stagedRangeCount = 0;
  let stagingEpoch = 0;
  let previousStagedIndex = -2;
  let lastSharedTransformUpdates = 0;
  let totalDirtyRanges = 0;
  let totalBytesUploaded = 0;
  const frameTimings: WasmFrameTimings = {
    systemsCpuTimeMs: 0,
    extractionCpuTimeMs: 0,
    visibilityCpuTimeMs: 0,
  };
  const stageTransform = (
    entity: number,
    fieldMask: number,
    values: Float32Array<ArrayBuffer>,
  ): void => {
    const index = entity & 0x000f_ffff;
    const alreadyStaged = stagedEpochs[index] === stagingEpoch;
    stagedEpochs[index] = stagingEpoch;
    transformUpdateGenerations[index] = entity >>> 20;
    transformUpdateMasks[index] = alreadyStaged
      ? (transformUpdateMasks[index] ?? 0) | fieldMask
      : fieldMask;
    const valueOffset = index * SHARED_TRANSFORM_FLOATS;
    if ((fieldMask & TransformField.Position) !== 0) {
      transformUpdateValues[valueOffset] = values[0] ?? 0;
      transformUpdateValues[valueOffset + 1] = values[1] ?? 0;
      transformUpdateValues[valueOffset + 2] = values[2] ?? 0;
      totalBytesUploaded += 12;
    }
    if ((fieldMask & TransformField.Rotation) !== 0) {
      transformUpdateValues[valueOffset + 3] = values[3] ?? 0;
      transformUpdateValues[valueOffset + 4] = values[4] ?? 0;
      transformUpdateValues[valueOffset + 5] = values[5] ?? 0;
      transformUpdateValues[valueOffset + 6] = values[6] ?? 0;
      totalBytesUploaded += 16;
    }
    if ((fieldMask & TransformField.Scale) !== 0) {
      transformUpdateValues[valueOffset + 7] = values[7] ?? 0;
      transformUpdateValues[valueOffset + 8] = values[8] ?? 0;
      transformUpdateValues[valueOffset + 9] = values[9] ?? 0;
      totalBytesUploaded += 12;
    }
    totalBytesUploaded += 8;
    if (alreadyStaged) return;
    if (index === previousStagedIndex + 1 && stagedRangeCount > 0) {
      transformRangeCounts[stagedRangeCount - 1] =
        (transformRangeCounts[stagedRangeCount - 1] ?? 0) + 1;
    } else {
      transformRangeStarts[stagedRangeCount] = index;
      transformRangeCounts[stagedRangeCount] = 1;
      stagedRangeCount += 1;
      totalBytesUploaded += 8;
    }
    previousStagedIndex = index;
    stagedTransformCount += 1;
  };
  let disposed = false;
  let sharedCommandConsumer: (command: RuntimeCommand) => void = () => undefined;
  const sharedCommandDecoder = createSharedCommandDecoder();
  const decodeAndConsumeSharedCommand: Parameters<typeof drainSharedCommands>[1] = (
    opcode,
    identity,
    offset,
    views,
  ) => {
    sharedCommandConsumer(sharedCommandDecoder.decode(opcode, identity, offset, views));
  };
  const updateSharedCommands = (consume: (command: RuntimeCommand) => void): void => {
    if (sharedViews === undefined) return;
    sharedCommandConsumer = consume;
    drainSharedCommands(sharedViews, decodeAndConsumeSharedCommand);
  };
  const updateSharedTransforms = (): void => {
    if (sharedViews === undefined) return;
    refreshMemoryViews();
    stagedTransformCount = 0;
    stagedRangeCount = 0;
    previousStagedIndex = -2;
    stagingEpoch = stagingEpoch === 0xffff_ffff ? 1 : stagingEpoch + 1;
    drainSharedTransforms(sharedViews, transformScratch, stageTransform);
    if (
      stagedTransformCount > 0 &&
      exports.lume_engine_apply_transform_ranges(handle, stagedRangeCount) !== stagedTransformCount
    ) {
      throw new Error("WASM rejected one or more shared transform updates.");
    }
    lastSharedTransformUpdates = stagedTransformCount;
    totalDirtyRanges += stagedRangeCount;
  };

  const core: WasmCore = {
    frameTimings,
    createBasicMaterial(materialHandle, color) {
      if (disposed) return;
      if (
        exports.lume_engine_add_material(
          handle,
          materialHandle,
          color[0],
          color[1],
          color[2],
          color[3],
        ) === 0
      ) {
        throw new Error(`WASM rejected basic-material resource ${materialHandle}.`);
      }
    },
    removeBasicMaterial(materialHandle) {
      if (disposed) return;
      if (exports.lume_engine_remove_material(handle, materialHandle) === 0) {
        throw new Error(`WASM rejected basic-material removal ${materialHandle}.`);
      }
    },
    apply(command: RuntimeCommand, aspect: number) {
      if (disposed) return;
      const accepted = applyCommand(exports, handle, command, aspect);
      if (accepted === 0) {
        throw new Error(`WASM rejected runtime command '${command.type}'.`);
      }
    },
    updateSharedCommands,
    updateSharedTransforms,
    update(profileStages = false) {
      refreshMemoryViews();
      if (!disposed) {
        if (profileStages) {
          let stageStart = performance.now();
          const systemsUpdated = exports.lume_engine_update_systems(handle);
          frameTimings.systemsCpuTimeMs = performance.now() - stageStart;
          stageStart = performance.now();
          const extracted = exports.lume_engine_extract(handle);
          frameTimings.extractionCpuTimeMs = performance.now() - stageStart;
          stageStart = performance.now();
          const visibilityUpdated = exports.lume_engine_update_visibility(handle);
          frameTimings.visibilityCpuTimeMs = performance.now() - stageStart;
          if (systemsUpdated === 0 || extracted === 0 || visibilityUpdated === 0) {
            throw new Error("WASM world update failed.");
          }
        } else if (exports.lume_engine_update(handle) === 0) {
          throw new Error("WASM world update failed.");
        }
      }
      refreshMemoryViews();
      frame.instanceCount = exports.lume_visible_count(handle);
      frame.dirtyRangeCount = exports.lume_render_dirty_range_count(handle);
      frame.stateDirtyRangeCount = exports.lume_render_state_dirty_range_count(handle);
      frame.boundsDirtyRangeCount = exports.lume_render_bounds_dirty_range_count(handle);
      frame.resourceDirtyRangeCount = exports.lume_render_resource_dirty_range_count(handle);
      frame.visibleSlotsDirty = exports.lume_visible_slots_dirty(handle) !== 0;
      frame.candidateCount = exports.lume_candidate_count(handle);
      frame.candidateSlotsDirty = exports.lume_candidate_slots_dirty(handle) !== 0;
      frame.cameraCount = exports.lume_render_camera_count(handle);
      frame.camerasDirty = exports.lume_render_cameras_dirty(handle) !== 0;
      return frame;
    },
    resize(aspect: number) {
      if (!disposed && exports.lume_engine_set_camera_aspect(handle, aspect) === 0) {
        throw new Error("WASM camera resize failed.");
      }
    },
    invalidateRendererCache() {
      if (!disposed && exports.lume_engine_invalidate_renderer_cache(handle) === 0) {
        throw new Error("WASM renderer-cache invalidation failed.");
      }
    },
    stats() {
      return {
        entities: exports.lume_engine_entity_count(handle),
        renderInstances: exports.lume_render_instance_count(handle),
        visibleObjects: exports.lume_visible_count(handle),
        sharedTransformUpdates: lastSharedTransformUpdates,
        dirtyRanges: totalDirtyRanges,
        bytesUploaded: totalBytesUploaded,
        wasmHeapBytes: exports.memory.buffer.byteLength,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      exports.lume_engine_destroy(handle);
    },
  };
  return core;
}

function describeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return JSON.stringify(value);
  }
}

function createFrameViews(
  memory: ArrayBuffer,
  visibleCapacity: number,
  renderEntityCapacity: number,
  cameraCapacity: number,
  geometriesPointer: number,
  pipelinesPointer: number,
  materialsPointer: number,
  visibleSlotsPointer: number,
  instancesPointer: number,
  slotStatesPointer: number,
  slotBoundsPointer: number,
  slotResourcesPointer: number,
  dirtyRangeStartsPointer: number,
  dirtyRangeCountsPointer: number,
  stateDirtyRangeStartsPointer: number,
  stateDirtyRangeCountsPointer: number,
  boundsDirtyRangeStartsPointer: number,
  boundsDirtyRangeCountsPointer: number,
  resourceDirtyRangeStartsPointer: number,
  resourceDirtyRangeCountsPointer: number,
  candidateGeometriesPointer: number,
  candidatePipelinesPointer: number,
  candidateMaterialsPointer: number,
  candidateSlotsPointer: number,
  camerasPointer: number,
): RenderFrame {
  return {
    instanceCount: 0,
    dirtyRangeCount: 0,
    stateDirtyRangeCount: 0,
    boundsDirtyRangeCount: 0,
    resourceDirtyRangeCount: 0,
    visibleSlotsDirty: false,
    candidateCount: 0,
    candidateSlotsDirty: false,
    cameraCount: 0,
    camerasDirty: false,
    geometries: new Uint32Array(memory, geometriesPointer, visibleCapacity),
    pipelines: new Uint32Array(memory, pipelinesPointer, visibleCapacity),
    materials: new Uint32Array(memory, materialsPointer, visibleCapacity),
    visibleSlots: new Uint32Array(memory, visibleSlotsPointer, visibleCapacity),
    candidateGeometries: new Uint32Array(memory, candidateGeometriesPointer, visibleCapacity),
    candidatePipelines: new Uint32Array(memory, candidatePipelinesPointer, visibleCapacity),
    candidateMaterials: new Uint32Array(memory, candidateMaterialsPointer, visibleCapacity),
    candidateSlots: new Uint32Array(memory, candidateSlotsPointer, visibleCapacity),
    instanceData: new Float32Array(
      memory,
      instancesPointer,
      renderEntityCapacity * INSTANCE_FLOATS,
    ),
    slotStates: new Uint32Array(
      memory,
      slotStatesPointer,
      renderEntityCapacity * SLOT_RECORD_WORDS,
    ),
    slotBounds: new Float32Array(
      memory,
      slotBoundsPointer,
      renderEntityCapacity * SLOT_RECORD_WORDS,
    ),
    slotResources: new Uint32Array(
      memory,
      slotResourcesPointer,
      renderEntityCapacity * SLOT_RECORD_WORDS,
    ),
    dirtyRangeStarts: new Uint32Array(memory, dirtyRangeStartsPointer, renderEntityCapacity),
    dirtyRangeCounts: new Uint32Array(memory, dirtyRangeCountsPointer, renderEntityCapacity),
    stateDirtyRangeStarts: new Uint32Array(
      memory,
      stateDirtyRangeStartsPointer,
      renderEntityCapacity,
    ),
    stateDirtyRangeCounts: new Uint32Array(
      memory,
      stateDirtyRangeCountsPointer,
      renderEntityCapacity,
    ),
    boundsDirtyRangeStarts: new Uint32Array(
      memory,
      boundsDirtyRangeStartsPointer,
      renderEntityCapacity,
    ),
    boundsDirtyRangeCounts: new Uint32Array(
      memory,
      boundsDirtyRangeCountsPointer,
      renderEntityCapacity,
    ),
    resourceDirtyRangeStarts: new Uint32Array(
      memory,
      resourceDirtyRangeStartsPointer,
      renderEntityCapacity,
    ),
    resourceDirtyRangeCounts: new Uint32Array(
      memory,
      resourceDirtyRangeCountsPointer,
      renderEntityCapacity,
    ),
    cameraData: new Float32Array(memory, camerasPointer, cameraCapacity * CAMERA_FLOATS),
  };
}

function applyCommand(
  wasm: LumeWasmExports,
  engine: number,
  command: RuntimeCommand,
  aspect: number,
): number {
  switch (command.type) {
    case "create-geometry":
    case "create-basic-material":
    case "retire-resource":
      throw new Error(`Resource command '${command.type}' bypassed the coordinator.`);
    case "spawn":
      return wasm.lume_engine_spawn(engine, command.entity);
    case "despawn":
      return wasm.lume_engine_despawn(engine, command.entity);
    case "add-transform":
      return wasm.lume_engine_add_transform(
        engine,
        command.entity,
        command.position[0],
        command.position[1],
        command.position[2],
        command.rotation[0],
        command.rotation[1],
        command.rotation[2],
        command.rotation[3],
        command.scale[0],
        command.scale[1],
        command.scale[2],
      );
    case "add-camera":
      return wasm.lume_engine_add_camera(
        engine,
        command.entity,
        command.verticalFov,
        command.near,
        command.far,
        aspect,
      );
    case "add-mesh":
      return wasm.lume_engine_add_mesh_renderer(
        engine,
        command.entity,
        command.geometry,
        command.material,
      );
    case "add-bounds":
      return wasm.lume_engine_add_bounds(
        engine,
        command.entity,
        command.center[0],
        command.center[1],
        command.center[2],
        command.radius,
      );
    case "remove-component":
      return wasm.lume_engine_remove_component(
        engine,
        command.entity,
        componentCode(command.component),
      );
  }
}

function componentCode(
  component: Extract<RuntimeCommand, { type: "remove-component" }>["component"],
): number {
  switch (component) {
    case "transform":
      return 1;
    case "camera":
      return 3;
    case "mesh":
      return 4;
    case "bounds":
      return 5;
  }
}
