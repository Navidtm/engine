import { describe, expect, it } from "vitest";

import type { CanvasAlphaMode, ClearColor, EngineConfig } from "./types.js";
import {
  DEFAULT_CAMERA_PERSPECTIVE,
  resolveCameraPerspective,
  resolveEngineBudgets,
  validateColor,
  validateComponent,
  validateEngineCameraOptions,
} from "./validation.js";

const alphaMode: CanvasAlphaMode = "premultiplied";
const clearColor: ClearColor = { r: 0, g: 0, b: 0, a: 1 };
const publicRendererConfig = { alphaMode, clearColor } satisfies Pick<
  EngineConfig,
  "alphaMode" | "clearColor"
>;
void publicRendererConfig;

const canvas = {} as HTMLCanvasElement;

describe("engine validation", () => {
  it("resolves public capacities into reserved-slot internal budgets", () => {
    expect(resolveEngineBudgets({ canvas, entityCapacity: 8 })).toEqual({
      entityCapacity: 9,
      resourceCapacity: 9,
      transformCapacity: 9,
      structuralCommandCapacity: 8,
      cameraCapacity: 8,
      meshRendererCapacity: 8,
      boundsCapacity: 8,
      capacities: {
        entities: 8,
        transforms: 8,
        meshRenderers: 8,
        cameras: 7,
        materials: 8,
        geometries: 8,
        bounds: 8,
        renderInstances: 8,
        renderCameras: 7,
      },
    });
    expect(
      resolveEngineBudgets({
        canvas,
        entityCapacity: 8,
        transport: { transformCapacity: 3, structuralCommandCapacity: 2 },
      }),
    ).toEqual({
      entityCapacity: 9,
      resourceCapacity: 9,
      transformCapacity: 4,
      structuralCommandCapacity: 2,
      cameraCapacity: 8,
      meshRendererCapacity: 8,
      boundsCapacity: 8,
      capacities: {
        entities: 8,
        transforms: 3,
        meshRenderers: 8,
        cameras: 7,
        materials: 8,
        geometries: 8,
        bounds: 8,
        renderInstances: 8,
        renderCameras: 7,
      },
    });
  });

  it("rejects invalid budgets before engine resources are created", () => {
    expect(() => resolveEngineBudgets({ canvas, entityCapacity: 0 })).toThrow("entityCapacity");
    expect(() =>
      resolveEngineBudgets({
        canvas,
        entityCapacity: 4,
        transport: { transformCapacity: 5 },
      }),
    ).toThrow("transport.transformCapacity");
    expect(() =>
      resolveEngineBudgets({
        canvas,
        entityCapacity: 4,
        transport: { structuralCommandCapacity: 5 },
      }),
    ).toThrow("transport.structuralCommandCapacity");
    expect(
      resolveEngineBudgets({
        canvas,
        entityCapacity: 1,
        componentCapacities: { meshRenderers: 0, cameras: 0, bounds: 0 },
      }),
    ).toMatchObject({
      meshRendererCapacity: 0,
      cameraCapacity: 1,
      boundsCapacity: 0,
      capacities: { meshRenderers: 0, cameras: 0, bounds: 0, renderCameras: 0 },
    });
  });

  it("merges partial perspective updates and validates the resulting range", () => {
    expect(resolveCameraPerspective({ near: 1 }, DEFAULT_CAMERA_PERSPECTIVE)).toEqual({
      verticalFov: Math.PI / 3,
      near: 1,
      far: 1_000,
    });
    expect(() => resolveCameraPerspective({ near: 2, far: 1 }, DEFAULT_CAMERA_PERSPECTIVE)).toThrow(
      "camera far",
    );
    expect(() =>
      resolveCameraPerspective({ verticalFov: Math.PI }, DEFAULT_CAMERA_PERSPECTIVE),
    ).toThrow("verticalFov");
    expect(() =>
      validateComponent({ kind: "camera", verticalFov: Math.PI, near: 0.1, far: 1_000 }),
    ).toThrow("verticalFov");
    expect(() => validateEngineCameraOptions({ rotation: [0, 0, 0, 0] })).toThrow(
      "rotation must be non-zero",
    );
  });

  it("validates linear RGBA tuples", () => {
    expect(() => validateColor([0, 0.5, 1, 1])).not.toThrow();
    expect(() => validateColor([0, -0.1, 1, 1])).toThrow("between 0 and 1");
  });
});
