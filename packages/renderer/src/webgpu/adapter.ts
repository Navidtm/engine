/** WebGPU adapter-selection preferences used by the renderer bootstrap. */
export interface AdapterOptions {
  /** Preferred power class; the browser may choose a different adapter. */
  readonly powerPreference?: GPUPowerPreference;
  /** Requests a fallback adapter when one is available. */
  readonly forceFallbackAdapter?: boolean;
}

/** Requests a compatible WebGPU adapter or throws an actionable availability error. */
export async function requestAdapter(options: AdapterOptions): Promise<GPUAdapter> {
  const gpu = navigator.gpu;
  if (gpu === undefined) {
    throw new Error("WebGPU is unavailable. Lume does not provide a WebGL fallback.");
  }
  const adapter = await gpu.requestAdapter(options);
  if (adapter === null) {
    throw new Error("WebGPU did not provide a compatible GPU adapter.");
  }
  return adapter;
}
