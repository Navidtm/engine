export interface DeviceOptions {
  readonly requiredFeatures?: readonly GPUFeatureName[];
  readonly label?: string;
}

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
