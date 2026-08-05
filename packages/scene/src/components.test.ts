import { describe, expect, it } from "vitest";

import { bounds, camera, material, transform } from "./components.js";

describe("component constructors", () => {
  it("creates immutable transform values with stable defaults", () => {
    const value = transform();
    expect(value.position).toEqual([0, 0, 0]);
    expect(Object.isFrozen(value)).toBe(true);
  });

  it("rejects invalid camera clipping planes", () => {
    expect(() => camera({ near: 10, far: 1 })).toThrow(RangeError);
  });

  it("rejects negative bounding spheres", () => {
    expect(() => bounds({ radius: -1 })).toThrow(RangeError);
  });

  it("rejects non-finite transforms, zero quaternions, and out-of-range colors", () => {
    expect(() => transform({ position: [Number.NaN, 0, 0] })).toThrow(RangeError);
    expect(() => transform({ rotation: [0, 0, 0, 0] })).toThrow(RangeError);
    expect(() => material({ color: [1, 0, 0, Number.POSITIVE_INFINITY] })).toThrow(RangeError);
    expect(() => material({ color: [1.1, 0, 0, 1] })).toThrow(RangeError);
  });
});
