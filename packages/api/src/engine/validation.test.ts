import { describe, expect, it } from "vitest";

import {
  DEFAULT_CAMERA_PERSPECTIVE,
  resolveCameraPerspective,
  resolveEngineBudgets,
  validateColor,
  validateEngineCameraOptions,
} from "./validation.js";

const canvas = {} as HTMLCanvasElement;

describe("engine validation", () => {
  it("resolves public capacities into reserved-slot internal budgets", () => {
    expect(resolveEngineBudgets({ canvas, entityCapacity: 8 })).toEqual({
      entityCapacity: 9,
      resourceCapacity: 9,
      transformCapacity: 9,
      structuralCommandCapacity: 8,
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
  });

  it("merges partial perspective updates and validates the resulting range", () => {
    expect(resolveCameraPerspective({ near: 1 }, DEFAULT_CAMERA_PERSPECTIVE)).toEqual({
      verticalFov: Math.PI / 3,
      near: 1,
      far: 1_000,
    });
    expect(() => resolveCameraPerspective({ near: 2, far: 1 }, DEFAULT_CAMERA_PERSPECTIVE)).toThrow(
      "Camera far",
    );
    expect(() => validateEngineCameraOptions({ rotation: [0, 0, 0, 0] })).toThrow(
      "rotation must be non-zero",
    );
  });

  it("validates linear RGBA tuples", () => {
    expect(() => validateColor([0, 0.5, 1, 1])).not.toThrow();
    expect(() => validateColor([0, -0.1, 1, 1])).toThrow("between 0 and 1");
  });
});
