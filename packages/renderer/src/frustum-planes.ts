const MATRIX_ELEMENTS = 16;
const PLANE_ELEMENTS = 4;

/** Writes six normalized WebGPU clip-space frustum planes without allocating. */
export function writeFrustumPlanes(
  output: Float32Array<ArrayBuffer>,
  outputOffset: number,
  camera: Float32Array<ArrayBuffer>,
  viewProjection: Float32Array<ArrayBuffer>,
): void {
  for (let column = 0; column < 4; column += 1) {
    const viewOffset = column * 4;
    for (let row = 0; row < 4; row += 1) {
      viewProjection[viewOffset + row] =
        (camera[MATRIX_ELEMENTS + row] ?? 0) * (camera[viewOffset] ?? 0) +
        (camera[MATRIX_ELEMENTS + 4 + row] ?? 0) * (camera[viewOffset + 1] ?? 0) +
        (camera[MATRIX_ELEMENTS + 8 + row] ?? 0) * (camera[viewOffset + 2] ?? 0) +
        (camera[MATRIX_ELEMENTS + 12 + row] ?? 0) * (camera[viewOffset + 3] ?? 0);
    }
  }

  const row0x = viewProjection[0] ?? 0;
  const row0y = viewProjection[4] ?? 0;
  const row0z = viewProjection[8] ?? 0;
  const row0w = viewProjection[12] ?? 0;
  const row1x = viewProjection[1] ?? 0;
  const row1y = viewProjection[5] ?? 0;
  const row1z = viewProjection[9] ?? 0;
  const row1w = viewProjection[13] ?? 0;
  const row2x = viewProjection[2] ?? 0;
  const row2y = viewProjection[6] ?? 0;
  const row2z = viewProjection[10] ?? 0;
  const row2w = viewProjection[14] ?? 0;
  const row3x = viewProjection[3] ?? 0;
  const row3y = viewProjection[7] ?? 0;
  const row3z = viewProjection[11] ?? 0;
  const row3w = viewProjection[15] ?? 0;

  const valid =
    writePlane(output, outputOffset, row3x + row0x, row3y + row0y, row3z + row0z, row3w + row0w) &&
    writePlane(
      output,
      outputOffset + 4,
      row3x - row0x,
      row3y - row0y,
      row3z - row0z,
      row3w - row0w,
    ) &&
    writePlane(
      output,
      outputOffset + 8,
      row3x + row1x,
      row3y + row1y,
      row3z + row1z,
      row3w + row1w,
    ) &&
    writePlane(
      output,
      outputOffset + 12,
      row3x - row1x,
      row3y - row1y,
      row3z - row1z,
      row3w - row1w,
    ) &&
    writePlane(output, outputOffset + 16, row2x, row2y, row2z, row2w) &&
    writePlane(
      output,
      outputOffset + 20,
      row3x - row2x,
      row3y - row2y,
      row3z - row2z,
      row3w - row2w,
    );
  if (!valid) output.fill(0, outputOffset, outputOffset + 6 * PLANE_ELEMENTS);
}

function writePlane(
  output: Float32Array<ArrayBuffer>,
  offset: number,
  x: number,
  y: number,
  z: number,
  distance: number,
): boolean {
  const lengthSquared = x * x + y * y + z * z;
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(z) ||
    !Number.isFinite(distance) ||
    !Number.isFinite(lengthSquared) ||
    lengthSquared <= 0
  ) {
    return false;
  }
  const inverseLength = 1 / Math.sqrt(lengthSquared);
  output[offset] = x * inverseLength;
  output[offset + 1] = y * inverseLength;
  output[offset + 2] = z * inverseLength;
  output[offset + 3] = distance * inverseLength;
  return true;
}
