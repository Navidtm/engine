import { describe, expect, it } from "vitest";
import { camera, transform } from "./components.js";

describe("component constructors", () => {
  it("creates immutable transform values with stable defaults", () => {
    const value = transform();
    expect(value.position).toEqual([0, 0, 0]);
    expect(Object.isFrozen(value)).toBe(true);
  });

  it("rejects invalid camera clipping planes", () => {
    expect(() => camera({ near: 10, far: 1 })).toThrow(RangeError);
  });
});
