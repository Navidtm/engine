import { TransformField } from "@lume/runtime";
import { bounds, material, mesh, type Quat, transform, type Vec3 } from "@lume/scene";

import type { EngineState } from "./engine/state.js";
import { publishTransform } from "./engine/transport.js";
import type {
  BasicMaterialHandle,
  BasicMaterialOptions,
  BuiltinGeometryApi,
  CreateApi,
  EngineHandle,
  MeshOptions,
  SceneHandle,
  SetApi,
  WorldApi,
} from "./engine/types.js";
import {
  ensureTransformSlotAvailable,
  validateColor,
  validateMeshOptions,
} from "./engine/validation.js";
import { createBasicMaterialResource, retireResource } from "./resource-lifecycle.js";
import {
  copyQuat,
  copyVec3,
  createMeshHandle,
  mutableTransform,
  type MutableTransformValue,
} from "./transform-controls.js";

export interface HighLevelApi {
  readonly create: CreateApi;
  readonly set: SetApi;
  readonly destroy: (handle: EngineHandle) => void;
}

/** Creates high-level material and mesh authoring over the advanced world facade. */
export function createHighLevelApi(
  state: EngineState,
  world: WorldApi,
  geometryApi: BuiltinGeometryApi,
): HighLevelApi {
  let defaultMaterial: BasicMaterialHandle | undefined;
  const transforms = new WeakMap<SceneHandle, MutableTransformValue>();
  const createBasicMaterial = (options: BasicMaterialOptions = {}): BasicMaterialHandle => {
    if (options.color !== undefined) validateColor(options.color);
    const descriptor = material(options);
    return createBasicMaterialResource(state, descriptor.color);
  };
  const defaultBasicMaterial = (): BasicMaterialHandle => {
    defaultMaterial ??= createBasicMaterial();
    return defaultMaterial;
  };
  const create: CreateApi = {
    basicMaterial: createBasicMaterial,
    mesh(options: MeshOptions) {
      validateMeshOptions(state, options);
      ensureTransformSlotAvailable(state);
      const materialHandle =
        options.material === undefined || options.material === "basic"
          ? defaultBasicMaterial()
          : options.material;
      const entity = world.createEntity();
      const initialTransform = mutableTransform(options);
      world.add(
        entity,
        transform({
          ...(options.position === undefined ? {} : { position: options.position }),
          ...(options.rotation === undefined ? {} : { rotation: options.rotation }),
          ...(options.scale === undefined ? {} : { scale: options.scale }),
        }),
      );
      const geometry =
        options.geometry === "cube"
          ? geometryApi.cube
          : options.geometry === "triangle"
            ? geometryApi.triangle
            : options.geometry;
      world.add(entity, mesh(geometry, materialHandle));
      if (options.bounds !== undefined) world.add(entity, bounds(options.bounds));
      const handle = createMeshHandle(state, entity, initialTransform);
      transforms.set(handle, initialTransform);
      return handle;
    },
  };
  const set: SetApi = {
    transform(
      handle: SceneHandle,
      options: {
        readonly position?: Vec3;
        readonly rotation?: Quat;
        readonly scale?: Vec3;
      },
    ) {
      const value = transforms.get(handle);
      if (value === undefined) throw new Error("Scene handle does not belong to this engine.");
      if (options.position !== undefined) copyVec3(value.position, options.position);
      if (options.rotation !== undefined) copyQuat(value.rotation, options.rotation);
      if (options.scale !== undefined) copyVec3(value.scale, options.scale);
      let fieldMask = 0;
      if (options.position !== undefined) fieldMask |= TransformField.Position;
      if (options.rotation !== undefined) fieldMask |= TransformField.Rotation;
      if (options.scale !== undefined) fieldMask |= TransformField.Scale;
      if (fieldMask !== 0) publishTransform(state, handle.id, value, fieldMask);
    },
  };
  return {
    create,
    set,
    destroy(handle: EngineHandle) {
      if (handle.kind === "mesh") {
        if (!transforms.has(handle))
          throw new Error("Scene handle does not belong to this engine.");
        world.destroyEntity(handle.id);
        transforms.delete(handle);
        return;
      }
      retireResource(state, handle);
      if (handle === defaultMaterial) defaultMaterial = undefined;
    },
  };
}
