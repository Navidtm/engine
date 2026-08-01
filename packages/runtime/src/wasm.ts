import type { RuntimeCommand } from "./protocol.js";
import type { RenderFrame } from "@lume/renderer";

const EXPECTED_ABI_VERSION = 2;
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
}

export interface WasmStats {
  readonly entities: number;
  readonly renderInstances: number;
  readonly wasmHeapBytes: number;
}

export interface WasmCore {
  apply(command: RuntimeCommand, aspect: number): void;
  resize(aspect: number): void;
  update(): RenderFrame;
  stats(): WasmStats;
  dispose(): void;
}

export async function createWasmCore(url: string, entityCapacity: number): Promise<WasmCore> {
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
  const renderEntityCapacity = exports.lume_render_entity_capacity(handle);
  const renderCameraCapacity = exports.lume_render_camera_capacity(handle);
  const geometriesPointer = exports.lume_render_geometries_ptr(handle);
  const instancesPointer = exports.lume_render_instances_ptr(handle);
  const camerasPointer = exports.lume_render_cameras_ptr(handle);
  let observedMemory = exports.memory.buffer;
  const frame: RenderFrame = createFrameViews(
    observedMemory,
    renderEntityCapacity,
    renderCameraCapacity,
    geometriesPointer,
    instancesPointer,
    camerasPointer,
  );
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
      if (!disposed && exports.lume_engine_update(handle) === 0) {
        throw new Error("WASM world update failed.");
      }
      if (exports.memory.buffer !== observedMemory) {
        observedMemory = exports.memory.buffer;
        const refreshed = createFrameViews(
          observedMemory,
          renderEntityCapacity,
          renderCameraCapacity,
          geometriesPointer,
          instancesPointer,
          camerasPointer,
        );
        frame.geometries = refreshed.geometries;
        frame.instanceData = refreshed.instanceData;
        frame.cameraData = refreshed.cameraData;
      }
      frame.instanceCount = exports.lume_render_instance_count(handle);
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
  entityCapacity: number,
  cameraCapacity: number,
  geometriesPointer: number,
  instancesPointer: number,
  camerasPointer: number,
): RenderFrame {
  return {
    instanceCount: 0,
    cameraCount: 0,
    geometries: new Uint32Array(memory, geometriesPointer, entityCapacity),
    instanceData: new Float32Array(memory, instancesPointer, entityCapacity * INSTANCE_FLOATS),
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
  }
}
