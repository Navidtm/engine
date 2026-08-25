import { describe, expect, it } from "vitest";

import { bounds, camera, material, transform } from "./components.js";

describe("component constructors", () => {
  it("creates typed transform values with independent defaults", () => {
    const first = transform();
    const second = transform();
    expect(first.position).toEqual([0, 0, 0]);
    expect(first.position).not.toBe(second.position);
  });

  it("rejects invalid camera clipping planes", () => {
    expect(() => camera({ near: 10, far: 1 })).toThrow(RangeError);
    expect(() => camera({ verticalFov: Math.PI })).toThrow(RangeError);
    expect(() => camera({ far: Number.POSITIVE_INFINITY })).toThrow(RangeError);
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
