import { describe, expect, it } from "vitest";

import { createMaterialRegistry } from "./material-registry.js";

describe("material registry generations", () => {
  it("accepts a live nonzero generation when rebuilding a fresh renderer", () => {
    const registry = createMaterialRegistry(2);
    const liveHandle = (7 << 20) | 1;

    registry.register(liveHandle);
    expect(registry.has(liveHandle)).toBe(true);
    expect(registry.remove(liveHandle)).toBe(true);
    expect(() => registry.register(liveHandle)).toThrow("material handle");
    expect(() => registry.register((8 << 20) | 1)).not.toThrow();
  });

  it("retires a material slot before its packed generation can wrap", () => {
    const registry = createMaterialRegistry(2);
    for (let generation = 0; generation <= 0x0fff; generation += 1) {
      const handle = (generation << 20) | 1;
      registry.register(handle);
      expect(registry.remove(handle)).toBe(true);
    }

    expect(() => registry.register(1)).toThrow("material handle");
    expect(registry.has(1)).toBe(false);
  });
});
