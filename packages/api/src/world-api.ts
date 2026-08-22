import type { RuntimeCommand } from "@lume/runtime";
import type { Component, Entity } from "@lume/scene";

import type { EngineState } from "./engine/state.js";
import { dispatchCommand } from "./engine/transport.js";
import type { WorldApi } from "./engine/types.js";
import { validateComponent, validateTransformSlot } from "./engine/validation.js";
import {
  allocateEntity,
  packEntity,
  releaseEntity,
  validateLiveEntity,
} from "./entity-lifecycle.js";
import {
  commitMeshResources,
  hasMeshResources,
  prepareMeshResources,
  releaseMeshResources,
} from "./resource-lifecycle.js";

/** Creates the advanced ECS authoring facade backed by one engine state. */
export function createWorldApi(state: EngineState): WorldApi {
  return {
    createEntity() {
      if (state.status === "disposed") throw new Error("Cannot create an entity after disposal.");
      const entity = allocateEntity(state);
      dispatchCommand(state, { type: "spawn", entity: packEntity(entity) });
      return entity;
    },
    destroyEntity(entity: Entity) {
      validateLiveEntity(state, entity);
      dispatchCommand(state, { type: "despawn", entity: packEntity(entity) });
      releaseMeshResources(state, entity);
      releaseEntity(state, entity);
    },
    add(entity: Entity, component: Component) {
      validateLiveEntity(state, entity);
      if (component.kind === "transform") validateTransformSlot(state, entity);
      const prepared =
        component.kind === "mesh"
          ? prepareMeshResources(state, entity, component.geometry, component.material)
          : undefined;
      dispatchCommand(state, componentCommand(entity, component, prepared));
      if (prepared !== undefined) commitMeshResources(state, prepared);
    },
    remove(entity: Entity, component: Component["kind"]) {
      validateLiveEntity(state, entity);
      if (component === "mesh" && !hasMeshResources(state, entity)) {
        throw new Error("Mesh component is not present on this entity.");
      }
      dispatchCommand(state, { type: "remove-component", entity: packEntity(entity), component });
      if (component === "mesh") releaseMeshResources(state, entity);
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
        position: component.position,
        rotation: component.rotation,
        scale: component.scale,
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
        center: component.center,
        radius: component.radius,
      };
  }
}
