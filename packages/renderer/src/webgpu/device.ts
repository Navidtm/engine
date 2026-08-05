/** Required capabilities and diagnostic label for a WebGPU device request. */
export interface DeviceOptions {
  /** Features that must be exposed by the selected adapter. */
  readonly requiredFeatures?: readonly GPUFeatureName[];
  /** Human-readable label attached to the WebGPU device. */
  readonly label?: string;
}

/** Validates required features then requests a WebGPU device. */
export async function requestDevice(
  adapter: GPUAdapter,
  options: DeviceOptions,
): Promise<GPUDevice> {
  const requested = options.requiredFeatures ?? [];
  for (const feature of requested) {
    if (!adapter.features.has(feature)) {
      throw new Error(`Required WebGPU feature is unavailable: ${feature}`);
    }
  }
  return adapter.requestDevice({
    label: options.label ?? "Lume WebGPU device",
    requiredFeatures: requested,
  });
}
