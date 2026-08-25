import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resizeSurface, type SurfaceState } from "./surface.js";

function createSurfaceState(depthTexture: GPUTexture): SurfaceState {
  return {
    canvas: { width: 4, height: 4 } as OffscreenCanvas,
    context: {} as GPUCanvasContext,
    format: "rgba8unorm",
    depthTexture,
    depthView: { label: "old view" } as GPUTextureView,
    width: 4,
    height: 4,
  };
}

describe("surface resize ownership", () => {
  beforeEach(() => vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1 }));
  afterEach(() => vi.unstubAllGlobals());

  it("preserves the current surface when replacement texture creation fails", () => {
    const oldTexture = { destroy: vi.fn() } as unknown as GPUTexture;
    const surface = createSurfaceState(oldTexture);
    const device = {
      limits: { maxTextureDimension2D: 4096 },
      createTexture: vi.fn(() => {
        throw new Error("texture failed");
      }),
    } as unknown as GPUDevice;

    expect(() =>
      resizeSurface(device, surface, { width: 8, height: 6, devicePixelRatio: 1 }),
    ).toThrow("texture failed");

    expect(oldTexture.destroy).not.toHaveBeenCalled();
    expect(surface.depthTexture).toBe(oldTexture);
    expect(surface.canvas.width).toBe(4);
    expect(surface.canvas.height).toBe(4);
    expect(surface.width).toBe(4);
    expect(surface.height).toBe(4);
  });

  it("destroys an incomplete replacement when view creation fails", () => {
    const oldTexture = { destroy: vi.fn() } as unknown as GPUTexture;
    const replacement = {
      createView: vi.fn(() => {
        throw new Error("view failed");
      }),
      destroy: vi.fn(),
    } as unknown as GPUTexture;
    const surface = createSurfaceState(oldTexture);
    const device = {
      limits: { maxTextureDimension2D: 4096 },
      createTexture: vi.fn(() => replacement),
    } as unknown as GPUDevice;

    expect(() =>
      resizeSurface(device, surface, { width: 8, height: 6, devicePixelRatio: 1 }),
    ).toThrow("view failed");

    expect(replacement.destroy).toHaveBeenCalledTimes(1);
    expect(oldTexture.destroy).not.toHaveBeenCalled();
    expect(surface.depthTexture).toBe(oldTexture);
    expect(surface.canvas.width).toBe(4);
    expect(surface.canvas.height).toBe(4);
  });
});
