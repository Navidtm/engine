import { TransformField } from "@lume/runtime";
import { camera, type Quat, transform, type Vec3 } from "@lume/scene";

import type { EngineState } from "./engine/state.js";
import { publishTransform } from "./engine/transport.js";
import type { EngineCamera, EngineCameraOptions, WorldApi } from "./engine/types.js";
import { DEFAULT_CAMERA_PERSPECTIVE, resolveCameraPerspective } from "./engine/validation.js";
import {
  createQuaternionControl,
  createVector3Control,
  mutableTransform,
} from "./transform-controls.js";

const DEFAULT_CAMERA_POSITION: Vec3 = [0, 0, 3];
const DEFAULT_CAMERA_ROTATION: Quat = [0, 0, 0, 1];

/** Creates the engine-owned active camera and its public controls. */
export function createEngineCamera(
  state: EngineState,
  world: WorldApi,
  options: EngineCameraOptions | undefined,
): EngineCamera {
  const entity = world.createEntity();
  const transformValue = mutableTransform({
    position: options?.position ?? DEFAULT_CAMERA_POSITION,
    rotation: options?.rotation ?? DEFAULT_CAMERA_ROTATION,
  });
  const perspective = resolveCameraPerspective(options, DEFAULT_CAMERA_PERSPECTIVE);
  world.add(
    entity,
    transform({ position: transformValue.position, rotation: transformValue.rotation }),
  );
  world.add(entity, camera(perspective));
  return {
    position: createVector3Control(transformValue.position, (next) =>
      publishTransform(
        state,
        entity,
        { ...transformValue, position: next },
        TransformField.Position,
      ),
    ),
    rotation: createQuaternionControl(transformValue.rotation, (next) =>
      publishTransform(
        state,
        entity,
        { ...transformValue, rotation: next },
        TransformField.Rotation,
      ),
    ),
    setPerspective(next) {
      if (state.status === "disposed" || state.status === "failed") {
        throw new Error(`Cannot update a ${state.status} engine.`);
      }
      const resolved = resolveCameraPerspective(next, perspective);
      perspective.verticalFov = resolved.verticalFov;
      perspective.near = resolved.near;
      perspective.far = resolved.far;
      world.add(entity, camera(perspective));
    },
  };
}
