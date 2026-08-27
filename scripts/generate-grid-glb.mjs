import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const GLB_MAGIC = 0x4654_6c67;
const JSON_CHUNK = 0x4e4f_534a;
const BIN_CHUNK = 0x004e_4942;

/** Builds a deterministic constrained-profile GLB without third-party source assets. */
export function generateGridGlb({ columns, rows, indexComponentType, maxIndices }) {
  requireInteger(columns, "columns", 2);
  requireInteger(rows, "rows", 2);
  if (indexComponentType !== 5123 && indexComponentType !== 5125) {
    throw new RangeError("indexComponentType must be 5123 or 5125.");
  }
  const vertexCount = columns * rows;
  if (indexComponentType === 5123 && vertexCount > 65_536) {
    throw new RangeError("UNSIGNED_SHORT fixtures cannot exceed 65,536 vertices.");
  }
  const availableIndices = (columns - 1) * (rows - 1) * 6;
  const indexCount = Math.min(maxIndices ?? availableIndices, availableIndices);
  if (!Number.isSafeInteger(indexCount) || indexCount <= 0 || indexCount % 3 !== 0) {
    throw new RangeError("maxIndices must produce a positive triangle-list index count.");
  }

  const positionBytes = vertexCount * 12;
  const normalOffset = positionBytes;
  const normalBytes = vertexCount * 12;
  const indexOffset = align4(normalOffset + normalBytes);
  const indexComponentBytes = indexComponentType === 5123 ? 2 : 4;
  const binaryByteLength = indexOffset + indexCount * indexComponentBytes;
  const binary = new ArrayBuffer(binaryByteLength);
  const view = new DataView(binary);
  const boundsMin = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const boundsMax = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];

  for (let row = 0; row < rows; row += 1) {
    const v = row / (rows - 1);
    for (let column = 0; column < columns; column += 1) {
      const u = column / (columns - 1);
      const vertex = row * columns + column;
      const x = Math.fround((u - 0.5) * 2);
      const y = Math.fround((v - 0.5) * 2);
      const phaseX = u * Math.PI * 6;
      const phaseY = v * Math.PI * 5;
      const z = Math.fround(Math.sin(phaseX) * Math.cos(phaseY) * 0.12);
      const slopeX = Math.cos(phaseX) * Math.cos(phaseY) * Math.PI * 0.72;
      const slopeY = -Math.sin(phaseX) * Math.sin(phaseY) * Math.PI * 0.6;
      const inverseLength = 1 / Math.hypot(slopeX, slopeY, 1);
      const nx = Math.fround(-slopeX * inverseLength);
      const ny = Math.fround(-slopeY * inverseLength);
      const nz = Math.fround(inverseLength);
      const positionOffset = vertex * 12;
      const vertexNormalOffset = normalOffset + vertex * 12;
      view.setFloat32(positionOffset, x, true);
      view.setFloat32(positionOffset + 4, y, true);
      view.setFloat32(positionOffset + 8, z, true);
      view.setFloat32(vertexNormalOffset, nx, true);
      view.setFloat32(vertexNormalOffset + 4, ny, true);
      view.setFloat32(vertexNormalOffset + 8, nz, true);
      boundsMin[0] = Math.min(boundsMin[0], x);
      boundsMin[1] = Math.min(boundsMin[1], y);
      boundsMin[2] = Math.min(boundsMin[2], z);
      boundsMax[0] = Math.max(boundsMax[0], x);
      boundsMax[1] = Math.max(boundsMax[1], y);
      boundsMax[2] = Math.max(boundsMax[2], z);
    }
  }

  let written = 0;
  for (let row = 0; row < rows - 1 && written < indexCount; row += 1) {
    for (let column = 0; column < columns - 1 && written < indexCount; column += 1) {
      const topLeft = row * columns + column;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + columns;
      const bottomRight = bottomLeft + 1;
      for (const index of [topLeft, bottomLeft, topRight, topRight, bottomLeft, bottomRight]) {
        if (written >= indexCount) break;
        const offset = indexOffset + written * indexComponentBytes;
        if (indexComponentType === 5123) view.setUint16(offset, index, true);
        else view.setUint32(offset, index, true);
        written += 1;
      }
    }
  }

  const document = {
    asset: { version: "2.0", generator: "Lume deterministic grid fixture" },
    buffers: [{ byteLength: binaryByteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes, target: 34962 },
      { buffer: 0, byteOffset: normalOffset, byteLength: normalBytes, target: 34962 },
      {
        buffer: 0,
        byteOffset: indexOffset,
        byteLength: indexCount * indexComponentBytes,
        target: 34963,
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: vertexCount,
        type: "VEC3",
        min: boundsMin,
        max: boundsMax,
      },
      { bufferView: 1, componentType: 5126, count: vertexCount, type: "VEC3" },
      { bufferView: 2, componentType: indexComponentType, count: indexCount, type: "SCALAR" },
    ],
    meshes: [
      {
        primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, mode: 4 }],
      },
    ],
  };
  const json = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = align4(json.byteLength);
  const binaryLength = align4(binary.byteLength);
  const totalLength = 12 + 8 + jsonLength + 8 + binaryLength;
  const output = new ArrayBuffer(totalLength);
  const outputView = new DataView(output);
  const bytes = new Uint8Array(output);
  outputView.setUint32(0, GLB_MAGIC, true);
  outputView.setUint32(4, 2, true);
  outputView.setUint32(8, totalLength, true);
  outputView.setUint32(12, jsonLength, true);
  outputView.setUint32(16, JSON_CHUNK, true);
  bytes.fill(0x20, 20, 20 + jsonLength);
  bytes.set(json, 20);
  const binaryHeader = 20 + jsonLength;
  outputView.setUint32(binaryHeader, binaryLength, true);
  outputView.setUint32(binaryHeader + 4, BIN_CHUNK, true);
  bytes.set(new Uint8Array(binary), binaryHeader + 8);
  return {
    bytes,
    metadata: {
      vertexCount,
      indexCount,
      indexComponentType,
      encodedBytes: totalLength,
      decodedBytes: vertexCount * 24 + indexCount * 4,
    },
  };
}

async function generateShowcaseAsset() {
  const outputPath = resolve(
    import.meta.dirname,
    "../examples/asset-showcase/public/assets/wave-grid.glb",
  );
  const fixture = generateGridGlb({ columns: 301, rows: 301, indexComponentType: 5125 });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, fixture.bytes);
  process.stdout.write(`${outputPath} (${fixture.metadata.encodedBytes} bytes)\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await generateShowcaseAsset();
}

function requireInteger(value, name, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be a safe integer greater than or equal to ${minimum}.`);
  }
}

function align4(value) {
  return (value + 3) & ~3;
}
