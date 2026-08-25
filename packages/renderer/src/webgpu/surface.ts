/** Mutable WebGPU canvas resources owned by one mesh renderer. */
export interface SurfaceState {
  /** Transferred canvas that owns the presentation surface. */
  readonly canvas: OffscreenCanvas;
  /** Configured WebGPU canvas context. */
  readonly context: GPUCanvasContext;
  /** Preferred presentation texture format. */
  readonly format: GPUTextureFormat;
  /** Owned depth texture; replaced during resize. */
  depthTexture: GPUTexture;
  /** Current depth attachment view. */
  depthView: GPUTextureView;
  /** Physical canvas width in pixels. */
  width: number;
  /** Physical canvas height in pixels. */
  height: number;
}

/** CSS-space dimensions supplied by the main thread for a surface update. */
export interface SurfaceSize {
  /** CSS pixel width. */
  readonly width: number;
  /** CSS pixel height. */
  readonly height: number;
  /** Device-pixel scale used to derive physical dimensions. */
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

/** Configures a canvas surface and creates its initial depth attachment. */
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

/** Recreates depth resources when a surface's physical size changes. */
export function resizeSurface(
  device: GPUDevice,
  surface: SurfaceState,
  size: SurfaceSize,
): boolean {
  const limit = device.limits.maxTextureDimension2D;
  const width = physicalDimension(size.width, size.devicePixelRatio, limit);
  const height = physicalDimension(size.height, size.devicePixelRatio, limit);
  if (width === surface.width && height === surface.height) return false;

  const depthTexture = createDepthTexture(device, width, height);
  let depthView: GPUTextureView;
  try {
    depthView = depthTexture.createView({ label: "Lume main depth view" });
  } catch (error) {
    depthTexture.destroy();
    throw error;
  }

  surface.canvas.width = width;
  surface.canvas.height = height;
  surface.depthTexture.destroy();
  surface.depthTexture = depthTexture;
  surface.depthView = depthView;
  surface.width = width;
  surface.height = height;
  return true;
}

/** Destroys the depth attachment and unconfigures the canvas context. */
export function destroySurface(surface: SurfaceState): void {
  surface.depthTexture.destroy();
  surface.context.unconfigure();
}
