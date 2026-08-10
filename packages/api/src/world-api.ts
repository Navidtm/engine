import type { RuntimeCommand } from "@lume/runtime";
import type { Component, Entity } from "@lume/scene";

import type { EngineState } from "./engine-state.js";
import { dispatchCommand } from "./engine-transport.js";
import type { WorldApi } from "./engine-types.js";
import { validateComponent, validateTransformSlot } from "./engine-validation.js";
import {
  allocateEntity,
  packEntity,
  releaseEntity,
  validateLiveEntity,
} from "./entity-lifecycle.js";

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
      releaseEntity(state, entity);
    },
    add(entity: Entity, component: Component) {
      validateLiveEntity(state, entity);
      if (component.kind === "transform") validateTransformSlot(state, entity);
      dispatchCommand(state, componentCommand(state, entity, component));
    },
    remove(entity: Entity, component: Component["kind"]) {
      validateLiveEntity(state, entity);
      dispatchCommand(state, { type: "remove-component", entity: packEntity(entity), component });
    },
  };
}

function componentCommand(
  state: EngineState,
  entity: Entity,
  component: Component,
): RuntimeCommand {
  validateComponent(state, component);
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
    case "material":
      return { type: "add-material", entity: packedEntity, color: component.color };
    case "camera":
      return {
        type: "add-camera",
        entity: packedEntity,
        verticalFov: component.verticalFov,
        near: component.near,
        far: component.far,
      };
    case "mesh":
      return {
        type: "add-mesh",
        entity: packedEntity,
        geometry: component.geometry.id,
        material: packEntity(component.material),
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
