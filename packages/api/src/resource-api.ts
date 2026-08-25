import { TransformField } from "@lume/runtime";
import { bounds, material, mesh, type Quat, transform, type Vec3 } from "@lume/scene";

import { ensureComponentSlotAvailable, releaseEntityComponents } from "./capacity.js";
import type { EngineState } from "./engine/state.js";
import {
  beginCommandTransaction,
  commitCommandTransaction,
  publishTransform,
  rollbackCommandTransaction,
} from "./engine/transport.js";
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
  validateFiniteTuple,
  validateMeshOptions,
  validateQuaternion,
} from "./engine/validation.js";
import { ensureEntitySlotAvailable, peekEntityIndex, releaseEntity } from "./entity-lifecycle.js";
import {
  createBasicMaterialResource,
  ensureResourceSlotAvailable,
  hasMeshResources,
  releaseMeshResources,
  retireResource,
  rollbackCreatedResource,
} from "./resource-lifecycle.js";
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
  const create: CreateApi = {
    basicMaterial: createBasicMaterial,
    mesh(options: MeshOptions) {
      validateMeshOptions(state, options);
      ensureEntitySlotAvailable(state);
      ensureTransformSlotAvailable(state);
      const entityIndex = peekEntityIndex(state);
      ensureComponentSlotAvailable(state.components, "transform", entityIndex);
      ensureComponentSlotAvailable(state.components, "mesh", entityIndex);
      if (options.bounds !== undefined) {
        ensureComponentSlotAvailable(state.components, "bounds", entityIndex);
      }
      const usesDefaultMaterial = options.material === undefined || options.material === "basic";
      const needsDefaultMaterial = usesDefaultMaterial && defaultMaterial === undefined;
      if (needsDefaultMaterial) ensureResourceSlotAvailable(state, "basic-material");
      const initialTransform = mutableTransform(options);
      const geometry =
        options.geometry === "cube"
          ? geometryApi.cube
          : options.geometry === "triangle"
            ? geometryApi.triangle
            : options.geometry;
      let entity: ReturnType<WorldApi["createEntity"]> | undefined;
      let createdDefaultMaterial: BasicMaterialHandle | undefined;
      beginCommandTransaction(state);
      try {
        if (needsDefaultMaterial) createdDefaultMaterial = createBasicMaterial();
        const materialHandle = usesDefaultMaterial
          ? (defaultMaterial ?? createdDefaultMaterial)
          : options.material;
        if (materialHandle === undefined) {
          throw new Error("Default material allocation failed.");
        }
        entity = world.createEntity();
        world.add(
          entity,
          transform({
            ...(options.position === undefined ? {} : { position: options.position }),
            ...(options.rotation === undefined ? {} : { rotation: options.rotation }),
            ...(options.scale === undefined ? {} : { scale: options.scale }),
          }),
        );
        world.add(entity, mesh(geometry, materialHandle));
        if (options.bounds !== undefined) world.add(entity, bounds(options.bounds));
        commitCommandTransaction(state);
      } catch (error) {
        rollbackCommandTransaction(state);
        if (entity !== undefined) {
          if (hasMeshResources(state, entity)) releaseMeshResources(state, entity);
          releaseEntityComponents(state.components, entity.index);
          releaseEntity(state, entity);
        }
        if (createdDefaultMaterial !== undefined) {
          rollbackCreatedResource(state, createdDefaultMaterial);
        }
        throw error;
      }
      if (createdDefaultMaterial !== undefined) defaultMaterial = createdDefaultMaterial;
      if (entity === undefined) throw new Error("Mesh entity allocation failed.");
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
      if (options.position !== undefined) validateFiniteTuple("position", options.position, 3);
      if (options.rotation !== undefined) validateQuaternion(options.rotation);
      if (options.scale !== undefined) validateFiniteTuple("scale", options.scale, 3);
      let fieldMask = 0;
      if (options.position !== undefined) fieldMask |= TransformField.Position;
      if (options.rotation !== undefined) fieldMask |= TransformField.Rotation;
      if (options.scale !== undefined) fieldMask |= TransformField.Scale;
      if (fieldMask === 0) return;
      publishTransform(
        state,
        handle.id,
        {
          position: options.position ?? value.position,
          rotation: options.rotation ?? value.rotation,
          scale: options.scale ?? value.scale,
        },
        fieldMask,
      );
      if (options.position !== undefined) copyVec3(value.position, options.position);
      if (options.rotation !== undefined) copyQuat(value.rotation, options.rotation);
      if (options.scale !== undefined) copyVec3(value.scale, options.scale);
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
