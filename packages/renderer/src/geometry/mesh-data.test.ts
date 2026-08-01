import { describe, expect, it } from "vitest";
import { BUILTIN_MESHES } from "./mesh-data.js";

describe("built-in CPU mesh data", () => {
  it("stores the cube as 24 position/normal vertices and 36 indices", () => {
    const cube = BUILTIN_MESHES.find((mesh) => mesh.handle === 2);
    expect(cube).toBeDefined();
    expect(cube?.vertices.length).toBe(24 * 6);
    expect(cube?.indices.length).toBe(36);
    expect(Math.max(...(cube?.indices ?? []))).toBe(23);
  });
});
