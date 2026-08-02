export function createStaticBuffer(
  device: GPUDevice,
  label: string,
  usage: GPUBufferUsageFlags,
  source: ArrayBufferView<ArrayBuffer>,
): GPUBuffer {
  const buffer = device.createBuffer({
    label,
    size: (source.byteLength + 3) & ~3,
    usage,
    mappedAtCreation: true,
  });
  try {
    const target = new Uint8Array(buffer.getMappedRange());
    target.set(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
    buffer.unmap();
    return buffer;
  } catch (error) {
    buffer.destroy();
    throw error;
  }
}
