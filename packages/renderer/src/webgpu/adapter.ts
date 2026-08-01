export interface AdapterOptions {
  readonly powerPreference?: GPUPowerPreference;
  readonly forceFallbackAdapter?: boolean;
}

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
