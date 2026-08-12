import type { RenderFrame } from "@lume/renderer";

import type { RuntimeCommand } from "./protocol.js";
import { SHARED_TRANSFORM_FLOATS, TransformField } from "./shared-memory/layout.js";
import { drainSharedCommands, StructuralOpcode } from "./shared-memory/structural.js";
import { drainSharedTransforms } from "./shared-memory/synchronization.js";
import { openSharedRuntimeViews } from "./shared-memory/views.js";
import { LUME_WASM_ABI_VERSION } from "./wasm-abi.js";

const INSTANCE_FLOATS = 20;
const CAMERA_FLOATS = 32;

interface LumeWasmExports extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  lume_abi_version(): number;
  lume_engine_create(entityCapacity: number, transformCapacity: number): number;
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
    entity: number,
    red: number,
    green: number,
    blue: number,
    alpha: number,
  ): number;
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
  lume_engine_set_camera_aspect(engine: number, aspect: number): number;
  lume_engine_entity_count(engine: number): number;
  lume_render_instance_count(engine: number): number;
  lume_render_camera_count(engine: number): number;
  lume_render_cameras_dirty(engine: number): number;
  lume_render_entity_capacity(engine: number): number;
  lume_render_camera_capacity(engine: number): number;
  lume_render_entities_ptr(engine: number): number;
  lume_render_geometries_ptr(engine: number): number;
  lume_render_instances_ptr(engine: number): number;
  lume_render_dirty_range_count(engine: number): number;
  lume_render_dirty_range_starts_ptr(engine: number): number;
  lume_render_dirty_range_counts_ptr(engine: number): number;
  lume_render_cameras_ptr(engine: number): number;
  lume_visible_count(engine: number): number;
  lume_visible_capacity(engine: number): number;
  lume_visible_slots_dirty(engine: number): number;
  lume_visible_geometries_ptr(engine: number): number;
  lume_visible_pipelines_ptr(engine: number): number;
  lume_visible_materials_ptr(engine: number): number;
  lume_visible_slots_ptr(engine: number): number;
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

/** Worker-only façade over the raw WASM ABI. */
export interface WasmCore {
  /** Applies one fallback structural command using the current camera aspect. */
  apply(command: RuntimeCommand, aspect: number): void;
  /** Drains the shared structural SPSC ring when that transport is active. */
  updateSharedCommands(): void;
  /** Updates all camera aspects after a valid surface resize. */
  resize(aspect: number): void;
  /** Drains shared transforms, advances ECS, and returns borrowed render views. */
  update(): RenderFrame;
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
  initialAspect = 1,
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
  const handle = exports.lume_engine_create(entityCapacity, transformCapacity);
  if (handle === 0) throw new Error("Lume WASM core allocation failed.");
  const visibleCapacity = exports.lume_visible_capacity(handle);
  const renderEntityCapacity = exports.lume_render_entity_capacity(handle);
  const renderCameraCapacity = exports.lume_render_camera_capacity(handle);
  const geometriesPointer = exports.lume_visible_geometries_ptr(handle);
  const pipelinesPointer = exports.lume_visible_pipelines_ptr(handle);
  const materialsPointer = exports.lume_visible_materials_ptr(handle);
  const visibleSlotsPointer = exports.lume_visible_slots_ptr(handle);
  const instancesPointer = exports.lume_render_instances_ptr(handle);
  const dirtyRangeStartsPointer = exports.lume_render_dirty_range_starts_ptr(handle);
  const dirtyRangeCountsPointer = exports.lume_render_dirty_range_counts_ptr(handle);
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
    dirtyRangeStartsPointer,
    dirtyRangeCountsPointer,
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
  const stagedEpochs = new Uint32Array(transformUpdateCapacity);
  const transformScratch = new Float32Array(SHARED_TRANSFORM_FLOATS);
  let stagedTransformCount = 0;
  let stagedRangeCount = 0;
  let stagingEpoch = 0;
  let previousStagedIndex = -2;
  let lastSharedTransformUpdates = 0;
  let totalDirtyRanges = 0;
  let totalBytesUploaded = 0;
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
  let currentAspect = initialAspect;
  const applyShared = (
    opcode: StructuralOpcode,
    entity: number,
    offset: number,
    views: ReturnType<typeof openSharedRuntimeViews>,
  ): void => {
    const accepted = applySharedCommand(
      exports,
      handle,
      opcode,
      entity,
      offset,
      views,
      currentAspect,
    );
    if (accepted === 0) throw new Error(`WASM rejected shared structural command ${opcode}.`);
  };
  const updateSharedCommands = (): void => {
    if (sharedViews === undefined) return;
    drainSharedCommands(sharedViews, applyShared);
  };

  const core: WasmCore = {
    apply(command: RuntimeCommand, aspect: number) {
      if (disposed) return;
      const accepted = applyCommand(exports, handle, command, aspect);
      if (accepted === 0) {
        throw new Error(`WASM rejected runtime command '${command.type}'.`);
      }
    },
    updateSharedCommands,
    update() {
      if (exports.memory.buffer !== observedMemory) {
        observedMemory = exports.memory.buffer;
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
          dirtyRangeStartsPointer,
          dirtyRangeCountsPointer,
          camerasPointer,
        );
        frame.geometries = refreshed.geometries;
        frame.pipelines = refreshed.pipelines;
        frame.materials = refreshed.materials;
        frame.visibleSlots = refreshed.visibleSlots;
        frame.instanceData = refreshed.instanceData;
        frame.dirtyRangeStarts = refreshed.dirtyRangeStarts;
        frame.dirtyRangeCounts = refreshed.dirtyRangeCounts;
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
      }
      if (sharedViews !== undefined) {
        updateSharedCommands();
        stagedTransformCount = 0;
        stagedRangeCount = 0;
        previousStagedIndex = -2;
        stagingEpoch = stagingEpoch === 0xffff_ffff ? 1 : stagingEpoch + 1;
        drainSharedTransforms(sharedViews, transformScratch, stageTransform);
        if (
          stagedTransformCount > 0 &&
          exports.lume_engine_apply_transform_ranges(handle, stagedRangeCount) !==
            stagedTransformCount
        ) {
          throw new Error("WASM rejected one or more shared transform updates.");
        }
        lastSharedTransformUpdates = stagedTransformCount;
        totalDirtyRanges += stagedRangeCount;
      }
      if (!disposed && exports.lume_engine_update(handle) === 0) {
        throw new Error("WASM world update failed.");
      }
      frame.instanceCount = exports.lume_visible_count(handle);
      frame.dirtyRangeCount = exports.lume_render_dirty_range_count(handle);
      frame.visibleSlotsDirty = exports.lume_visible_slots_dirty(handle) !== 0;
      frame.cameraCount = exports.lume_render_camera_count(handle);
      frame.camerasDirty = exports.lume_render_cameras_dirty(handle) !== 0;
      return frame;
    },
    resize(aspect: number) {
      currentAspect = aspect;
      if (!disposed && exports.lume_engine_set_camera_aspect(handle, aspect) === 0) {
        throw new Error("WASM camera resize failed.");
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
  dirtyRangeStartsPointer: number,
  dirtyRangeCountsPointer: number,
  camerasPointer: number,
): RenderFrame {
  return {
    instanceCount: 0,
    dirtyRangeCount: 0,
    visibleSlotsDirty: false,
    cameraCount: 0,
    camerasDirty: false,
    geometries: new Uint32Array(memory, geometriesPointer, visibleCapacity),
    pipelines: new Uint32Array(memory, pipelinesPointer, visibleCapacity),
    materials: new Uint32Array(memory, materialsPointer, visibleCapacity),
    visibleSlots: new Uint32Array(memory, visibleSlotsPointer, visibleCapacity),
    instanceData: new Float32Array(
      memory,
      instancesPointer,
      renderEntityCapacity * INSTANCE_FLOATS,
    ),
    dirtyRangeStarts: new Uint32Array(memory, dirtyRangeStartsPointer, renderEntityCapacity),
    dirtyRangeCounts: new Uint32Array(memory, dirtyRangeCountsPointer, renderEntityCapacity),
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
    case "spawn":
      return wasm.lume_engine_spawn(engine, command.entity);
    case "despawn":
      return wasm.lume_engine_despawn(engine, command.entity);
    case "add-transform":
      return wasm.lume_engine_add_transform(
        engine,
        command.entity,
        ...command.position,
        ...command.rotation,
        ...command.scale,
      );
    case "add-material":
      return wasm.lume_engine_add_material(engine, command.entity, ...command.color);
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
      return wasm.lume_engine_add_bounds(engine, command.entity, ...command.center, command.radius);
    case "remove-component":
      return wasm.lume_engine_remove_component(
        engine,
        command.entity,
        componentCode(command.component),
      );
  }
}

function applySharedCommand(
  wasm: LumeWasmExports,
  engine: number,
  opcode: StructuralOpcode,
  entity: number,
  offset: number,
  views: ReturnType<typeof openSharedRuntimeViews>,
  aspect: number,
): number {
  const floats = views.commandFloats;
  const words = views.commandWords;
  const float = (word: number): number => floats[offset + word] ?? 0;
  const integer = (word: number): number => words[offset + word] ?? 0;
  switch (opcode) {
    case StructuralOpcode.Spawn:
      return wasm.lume_engine_spawn(engine, entity);
    case StructuralOpcode.Despawn:
      return wasm.lume_engine_despawn(engine, entity);
    case StructuralOpcode.AddTransform:
      return wasm.lume_engine_add_transform(
        engine,
        entity,
        float(2),
        float(3),
        float(4),
        float(5),
        float(6),
        float(7),
        float(8),
        float(9),
        float(10),
        float(11),
      );
    case StructuralOpcode.AddMaterial:
      return wasm.lume_engine_add_material(engine, entity, float(2), float(3), float(4), float(5));
    case StructuralOpcode.AddCamera:
      return wasm.lume_engine_add_camera(engine, entity, float(2), float(3), float(4), aspect);
    case StructuralOpcode.AddMesh:
      return wasm.lume_engine_add_mesh_renderer(engine, entity, integer(2), integer(3));
    case StructuralOpcode.AddBounds:
      return wasm.lume_engine_add_bounds(engine, entity, float(2), float(3), float(4), float(5));
    case StructuralOpcode.RemoveTransform:
    case StructuralOpcode.RemoveMaterial:
    case StructuralOpcode.RemoveCamera:
    case StructuralOpcode.RemoveMesh:
    case StructuralOpcode.RemoveBounds:
      return wasm.lume_engine_remove_component(
        engine,
        entity,
        opcode - StructuralOpcode.RemoveTransform + 1,
      );
  }
}

function componentCode(
  component: Extract<RuntimeCommand, { type: "remove-component" }>["component"],
): number {
  switch (component) {
    case "transform":
      return 1;
    case "material":
      return 2;
    case "camera":
      return 3;
    case "mesh":
      return 4;
    case "bounds":
      return 5;
  }
}
