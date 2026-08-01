import type { RenderFrame } from "@lume/renderer";

import type { RuntimeCommand } from "./protocol.js";
import { SHARED_TRANSFORM_FLOATS } from "./shared-memory/layout.js";
import { drainSharedTransforms } from "./shared-memory/synchronization.js";
import { openSharedRuntimeViews } from "./shared-memory/views.js";

const EXPECTED_ABI_VERSION = 4;
const INSTANCE_FLOATS = 20;
const CAMERA_FLOATS = 32;

interface LumeWasmExports extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  lume_abi_version(): number;
  lume_engine_create(entityCapacity: number): number;
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
  lume_transform_update_entities_ptr(engine: number): number;
  lume_transform_update_values_ptr(engine: number): number;
  lume_engine_apply_transform_updates(engine: number, updateCount: number): number;
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
  lume_engine_update(engine: number): number;
  lume_engine_set_camera_aspect(engine: number, aspect: number): number;
  lume_engine_entity_count(engine: number): number;
  lume_render_instance_count(engine: number): number;
  lume_render_camera_count(engine: number): number;
  lume_render_entity_capacity(engine: number): number;
  lume_render_camera_capacity(engine: number): number;
  lume_render_entities_ptr(engine: number): number;
  lume_render_geometries_ptr(engine: number): number;
  lume_render_instances_ptr(engine: number): number;
  lume_render_cameras_ptr(engine: number): number;
  lume_visible_count(engine: number): number;
  lume_visible_capacity(engine: number): number;
  lume_visible_geometries_ptr(engine: number): number;
  lume_visible_pipelines_ptr(engine: number): number;
  lume_visible_materials_ptr(engine: number): number;
  lume_visible_instances_ptr(engine: number): number;
}

export interface WasmStats {
  readonly entities: number;
  readonly renderInstances: number;
  readonly visibleObjects: number;
  readonly sharedTransformUpdates: number;
  readonly wasmHeapBytes: number;
}

export interface WasmCore {
  apply(command: RuntimeCommand, aspect: number): void;
  resize(aspect: number): void;
  update(): RenderFrame;
  stats(): WasmStats;
  dispose(): void;
}

export async function createWasmCore(
  url: string,
  entityCapacity: number,
  sharedMemory?: SharedArrayBuffer,
): Promise<WasmCore> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load Lume WASM (${response.status} ${response.statusText}).`);
  }
  const module = await WebAssembly.instantiate(await response.arrayBuffer(), {});
  const exports = module.instance.exports as LumeWasmExports;
  if (exports.lume_abi_version?.() !== EXPECTED_ABI_VERSION) {
    throw new Error("Lume WASM ABI version does not match the TypeScript runtime.");
  }
  const handle = exports.lume_engine_create(entityCapacity);
  if (handle === 0) throw new Error("Lume WASM core allocation failed.");
  const visibleCapacity = exports.lume_visible_capacity(handle);
  const renderCameraCapacity = exports.lume_render_camera_capacity(handle);
  const geometriesPointer = exports.lume_visible_geometries_ptr(handle);
  const pipelinesPointer = exports.lume_visible_pipelines_ptr(handle);
  const materialsPointer = exports.lume_visible_materials_ptr(handle);
  const instancesPointer = exports.lume_visible_instances_ptr(handle);
  const camerasPointer = exports.lume_render_cameras_ptr(handle);
  const transformUpdateCapacity = exports.lume_transform_update_capacity(handle);
  const transformUpdateEntitiesPointer = exports.lume_transform_update_entities_ptr(handle);
  const transformUpdateValuesPointer = exports.lume_transform_update_values_ptr(handle);
  const sharedViews = sharedMemory === undefined ? undefined : openSharedRuntimeViews(sharedMemory);
  if (sharedViews !== undefined && sharedViews.layout.capacity > transformUpdateCapacity) {
    exports.lume_engine_destroy(handle);
    throw new Error("Shared transform capacity exceeds WASM staging capacity.");
  }
  let observedMemory = exports.memory.buffer;
  const frame: RenderFrame = createFrameViews(
    observedMemory,
    visibleCapacity,
    renderCameraCapacity,
    geometriesPointer,
    pipelinesPointer,
    materialsPointer,
    instancesPointer,
    camerasPointer,
  );
  let transformUpdateEntities = new Uint32Array(
    observedMemory,
    transformUpdateEntitiesPointer,
    transformUpdateCapacity,
  );
  let transformUpdateValues = new Float32Array(
    observedMemory,
    transformUpdateValuesPointer,
    transformUpdateCapacity * SHARED_TRANSFORM_FLOATS,
  );
  const transformScratch = new Float32Array(SHARED_TRANSFORM_FLOATS);
  let stagedTransformCount = 0;
  let lastSharedTransformUpdates = 0;
  const stageTransform = (entity: number, values: Float32Array<ArrayBuffer>): void => {
    transformUpdateEntities[stagedTransformCount] = entity;
    transformUpdateValues.set(values, stagedTransformCount * SHARED_TRANSFORM_FLOATS);
    stagedTransformCount += 1;
  };
  let disposed = false;

  const core: WasmCore = {
    apply(command: RuntimeCommand, aspect: number) {
      if (disposed) return;
      const accepted = applyCommand(exports, handle, command, aspect);
      if (accepted === 0) {
        throw new Error(`WASM rejected runtime command '${command.type}'.`);
      }
    },
    update() {
      if (exports.memory.buffer !== observedMemory) {
        observedMemory = exports.memory.buffer;
        const refreshed = createFrameViews(
          observedMemory,
          visibleCapacity,
          renderCameraCapacity,
          geometriesPointer,
          pipelinesPointer,
          materialsPointer,
          instancesPointer,
          camerasPointer,
        );
        frame.geometries = refreshed.geometries;
        frame.pipelines = refreshed.pipelines;
        frame.materials = refreshed.materials;
        frame.instanceData = refreshed.instanceData;
        frame.cameraData = refreshed.cameraData;
        transformUpdateEntities = new Uint32Array(
          observedMemory,
          transformUpdateEntitiesPointer,
          transformUpdateCapacity,
        );
        transformUpdateValues = new Float32Array(
          observedMemory,
          transformUpdateValuesPointer,
          transformUpdateCapacity * SHARED_TRANSFORM_FLOATS,
        );
      }
      if (sharedViews !== undefined) {
        stagedTransformCount = 0;
        drainSharedTransforms(sharedViews, transformScratch, stageTransform);
        if (
          stagedTransformCount > 0 &&
          exports.lume_engine_apply_transform_updates(handle, stagedTransformCount) !==
            stagedTransformCount
        ) {
          throw new Error("WASM rejected one or more shared transform updates.");
        }
        lastSharedTransformUpdates = stagedTransformCount;
      }
      if (!disposed && exports.lume_engine_update(handle) === 0) {
        throw new Error("WASM world update failed.");
      }
      frame.instanceCount = exports.lume_visible_count(handle);
      frame.cameraCount = exports.lume_render_camera_count(handle);
      return frame;
    },
    resize(aspect: number) {
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
        wasmHeapBytes: exports.memory.buffer.byteLength,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      exports.lume_engine_destroy(handle);
    },
  };
  return Object.freeze(core);
}

function createFrameViews(
  memory: ArrayBuffer,
  visibleCapacity: number,
  cameraCapacity: number,
  geometriesPointer: number,
  pipelinesPointer: number,
  materialsPointer: number,
  instancesPointer: number,
  camerasPointer: number,
): RenderFrame {
  return {
    instanceCount: 0,
    cameraCount: 0,
    geometries: new Uint32Array(memory, geometriesPointer, visibleCapacity),
    pipelines: new Uint32Array(memory, pipelinesPointer, visibleCapacity),
    materials: new Uint32Array(memory, materialsPointer, visibleCapacity),
    instanceData: new Float32Array(memory, instancesPointer, visibleCapacity * INSTANCE_FLOATS),
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
  }
}
