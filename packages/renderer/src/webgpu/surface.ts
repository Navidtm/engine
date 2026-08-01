export interface SurfaceState {
  readonly canvas: OffscreenCanvas;
  readonly context: GPUCanvasContext;
  readonly format: GPUTextureFormat;
  depthTexture: GPUTexture;
  depthView: GPUTextureView;
  width: number;
  height: number;
}

export interface SurfaceSize {
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
}

function physicalDimension(value: number, scale: number, limit: number): number {
  return Math.max(1, Math.min(limit, Math.round(value * scale)));
}

function createDepthTexture(device: GPUDevice, width: number, height: number): GPUTexture {
  return device.createTexture({
    label: "Lume main depth",
    size: { width, height },
    format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
}

export function createSurface(
  device: GPUDevice,
  canvas: OffscreenCanvas,
  size: SurfaceSize,
  alphaMode: GPUCanvasAlphaMode,
): SurfaceState {
  const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
  if (context === null) {
    throw new Error("The transferred canvas could not create a WebGPU context.");
  }
  const limit = device.limits.maxTextureDimension2D;
  const width = physicalDimension(size.width, size.devicePixelRatio, limit);
  const height = physicalDimension(size.height, size.devicePixelRatio, limit);
  canvas.width = width;
  canvas.height = height;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode });
  const depthTexture = createDepthTexture(device, width, height);
  return {
    canvas,
    context,
    format,
    depthTexture,
    depthView: depthTexture.createView({ label: "Lume main depth view" }),
    width,
    height,
  };
}

export function resizeSurface(
  device: GPUDevice,
  surface: SurfaceState,
  size: SurfaceSize,
): boolean {
  const limit = device.limits.maxTextureDimension2D;
  const width = physicalDimension(size.width, size.devicePixelRatio, limit);
  const height = physicalDimension(size.height, size.devicePixelRatio, limit);
  if (width === surface.width && height === surface.height) return false;

  surface.depthTexture.destroy();
  surface.canvas.width = width;
  surface.canvas.height = height;
  surface.depthTexture = createDepthTexture(device, width, height);
  surface.depthView = surface.depthTexture.createView({ label: "Lume main depth view" });
  surface.width = width;
  surface.height = height;
  return true;
}

export function destroySurface(surface: SurfaceState): void {
  surface.depthTexture.destroy();
  surface.context.unconfigure();
}
