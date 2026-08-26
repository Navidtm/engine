import type { RuntimeCommand } from "@lume/runtime";
import type { Component, Entity } from "@lume/scene";

import {
  commitComponent,
  ensureComponentSlotAvailable,
  hasComponent,
  releaseEntityComponents,
  removeComponentMirror,
} from "./capacity.js";
import type { EngineState } from "./engine/state.js";
import { dispatchCommand } from "./engine/transport.js";
import type { WorldApi } from "./engine/types.js";
import { validateComponent, validateTransformSlot } from "./engine/validation.js";
import {
  allocateEntity,
  ensureEntitySlotAvailable,
  packEntity,
  releaseEntity,
  validateLiveEntity,
} from "./entity-lifecycle.js";
import {
  commitMeshResources,
  prepareMeshResources,
  releaseMeshResources,
} from "./resource-lifecycle.js";

/** Creates the advanced ECS authoring facade backed by one engine state. */
export function createWorldApi(state: EngineState): WorldApi {
  return {
    createEntity() {
      if (state.status === "disposed") throw new Error("Cannot create an entity after disposal.");
      if (state.status === "failed") throw new Error("Cannot create an entity on a failed engine.");
      ensureEntitySlotAvailable(state);
      const entity = allocateEntity(state);
      dispatchCommand(state, { type: "spawn", entity: packEntity(entity) });
      return entity;
    },
    destroyEntity(entity: Entity) {
      validateLiveEntity(state, entity);
      dispatchCommand(state, { type: "despawn", entity: packEntity(entity) });
      releaseMeshResources(state, entity);
      releaseEntityComponents(state.components, entity.index);
      releaseEntity(state, entity);
    },
    add(entity: Entity, component: Component) {
      validateLiveEntity(state, entity);
      if (component.kind === "transform") validateTransformSlot(state, entity);
      ensureComponentSlotAvailable(state.components, component.kind, entity.index);
      const prepared =
        component.kind === "mesh"
          ? prepareMeshResources(state, entity, component.geometry, component.material)
          : undefined;
      dispatchCommand(state, componentCommand(entity, component, prepared));
      commitComponent(state.components, component.kind, entity.index);
      if (prepared !== undefined) commitMeshResources(state, prepared);
    },
    remove(entity: Entity, component: Component["kind"]) {
      validateLiveEntity(state, entity);
      if (!hasComponent(state.components, component, entity.index)) {
        throw new Error(`${component} component is not present on this entity.`);
      }
      dispatchCommand(state, { type: "remove-component", entity: packEntity(entity), component });
      if (component === "mesh") releaseMeshResources(state, entity);
      removeComponentMirror(state.components, component, entity.index);
    },
  };
}

function componentCommand(
  entity: Entity,
  component: Component,
  prepared?: ReturnType<typeof prepareMeshResources>,
): RuntimeCommand {
  validateComponent(component);
  const packedEntity = packEntity(entity);
  switch (component.kind) {
    case "transform":
      return {
        type: "add-transform",
        entity: packedEntity,
        position: [component.position[0], component.position[1], component.position[2]],
        rotation: [
          component.rotation[0],
          component.rotation[1],
          component.rotation[2],
          component.rotation[3],
        ],
        scale: [component.scale[0], component.scale[1], component.scale[2]],
      };
    case "camera":
      return {
        type: "add-camera",
        entity: packedEntity,
        verticalFov: component.verticalFov,
        near: component.near,
        far: component.far,
      };
    case "mesh":
      if (prepared === undefined) throw new Error("Mesh resources were not prepared.");
      return {
        type: "add-mesh",
        entity: packedEntity,
        geometry: prepared.geometry,
        material: prepared.material,
      };
    case "bounds":
      return {
        type: "add-bounds",
        entity: packedEntity,
        center: [component.center[0], component.center[1], component.center[2]],
        radius: component.radius,
      };
  }
}
