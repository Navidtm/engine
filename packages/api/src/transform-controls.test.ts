import { describe, expect, it, vi } from "vitest";

import {
  createQuaternionControl,
  createVector3Control,
  mutableTransform,
} from "./transform-controls.js";

describe("transform controls", () => {
  it("owns copies of authoring tuples", () => {
    const position: [number, number, number] = [1, 2, 3];
    const value = mutableTransform({ position });
    position[0] = 9;

    expect(value.position).toEqual([1, 2, 3]);
    expect(value.rotation).toEqual([0, 0, 0, 1]);
    expect(value.scale).toEqual([1, 1, 1]);
  });

  it("updates vector storage before publishing exactly once", () => {
    const value: [number, number, number] = [0, 0, 0];
    const publish = vi.fn(() => expect(value).toEqual([1, 2, 3]));
    const control = createVector3Control(value, publish);

    control.set(1, 2, 3);

    expect([control.x, control.y, control.z]).toEqual([1, 2, 3]);
    expect(publish).toHaveBeenCalledOnce();
  });

  it("does not mutate or publish an invalid quaternion update", () => {
    const value: [number, number, number, number] = [0, 0, 0, 1];
    const publish = vi.fn();
    const control = createQuaternionControl(value, publish);

    expect(() => control.set(0, Number.NaN, 0, 1)).toThrow("quaternion");
    expect(() => control.set(0, 0, 0, 0)).toThrow("non-zero");
    expect(value).toEqual([0, 0, 0, 1]);
    expect(publish).not.toHaveBeenCalled();
  });
});
