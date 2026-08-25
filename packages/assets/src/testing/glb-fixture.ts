import type { GlbIndexComponentType } from "../types.js";

const JSON_CHUNK = 0x4e4f_534a;
const BIN_CHUNK = 0x004e_4942;

export interface FixtureAccessor {
  bufferView?: unknown;
  byteOffset?: unknown;
  componentType?: unknown;
  normalized?: unknown;
  count?: unknown;
  type?: unknown;
  min?: unknown;
  max?: unknown;
  sparse?: unknown;
  extensions?: unknown;
}

export interface FixtureBufferView {
  buffer?: unknown;
  byteOffset?: unknown;
  byteLength?: unknown;
  byteStride?: unknown;
  target?: unknown;
  extensions?: unknown;
}

export interface FixturePrimitive {
  attributes: Record<string, unknown>;
  indices?: unknown;
  material?: unknown;
  mode?: unknown;
  targets?: unknown;
  extensions?: unknown;
}

export interface FixtureDocument {
  asset: { version?: unknown; minVersion?: unknown };
  buffers: Array<{ byteLength?: unknown; uri?: unknown }>;
  bufferViews: FixtureBufferView[];
  accessors: FixtureAccessor[];
  meshes: Array<{ primitives: FixturePrimitive[]; weights?: unknown; extensions?: unknown }>;
  extensionsRequired?: unknown;
  extensionsUsed?: unknown;
  animations?: unknown;
  images?: unknown;
  materials?: unknown;
  samplers?: unknown;
  skins?: unknown;
  textures?: unknown;
}

export interface GlbFixture {
  readonly buffer: ArrayBuffer;
  readonly binaryOffset: number;
  readonly document: FixtureDocument;
}

export interface GlbFixtureOptions {
  readonly positions?: readonly number[];
  readonly normals?: readonly number[];
  readonly indices?: readonly number[];
  readonly indexComponentType?: GlbIndexComponentType;
  readonly interleavedAttributes?: boolean;
  readonly omitBinChunk?: boolean;
  readonly trailingUnknownChunk?: boolean;
  readonly mutateDocument?: (document: FixtureDocument) => void;
}

const DEFAULT_POSITIONS = [0, 0, 0, 1, 0, 0, 0, 1, 0] as const;
const DEFAULT_NORMALS = [0, 0, 1, 0, 0, 1, 0, 0, 1] as const;
const DEFAULT_INDICES = [0, 1, 2] as const;

/** Builds small deterministic GLBs without committing opaque binary fixtures. */
export function createGlbFixture(options: GlbFixtureOptions = {}): GlbFixture {
  const positions = options.positions ?? DEFAULT_POSITIONS;
  const normals = options.normals ?? DEFAULT_NORMALS;
  const indices = options.indices ?? DEFAULT_INDICES;
  const componentType = options.indexComponentType ?? 5123;
  if (positions.length % 3 !== 0 || normals.length !== positions.length) {
    throw new Error("Fixture position and normal values must contain matching VEC3 elements.");
  }
  const vertexCount = positions.length / 3;
  const indexComponentBytes = componentType === 5123 ? 2 : 4;
  const interleaved = options.interleavedAttributes ?? false;
  const positionBytes = positions.length * 4;
  const normalBytes = normals.length * 4;
  const vertexBytes = interleaved ? vertexCount * 24 : positionBytes + normalBytes;
  const indexOffset = align4(vertexBytes);
  const binaryByteLength = indexOffset + indices.length * indexComponentBytes;
  const binary = new ArrayBuffer(binaryByteLength);
  const binaryView = new DataView(binary);

  const bufferViews: FixtureBufferView[] = [];
  const accessors: FixtureAccessor[] = [];
  if (interleaved) {
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      for (let component = 0; component < 3; component += 1) {
        binaryView.setFloat32(
          vertex * 24 + component * 4,
          positions[vertex * 3 + component] ?? 0,
          true,
        );
        binaryView.setFloat32(
          vertex * 24 + 12 + component * 4,
          normals[vertex * 3 + component] ?? 0,
          true,
        );
      }
    }
    bufferViews.push({
      buffer: 0,
      byteOffset: 0,
      byteLength: vertexBytes,
      byteStride: 24,
      target: 34_962,
    });
    accessors.push(
      {
        bufferView: 0,
        byteOffset: 0,
        componentType: 5126,
        count: vertexCount,
        type: "VEC3",
        min: componentBounds(positions, Math.min),
        max: componentBounds(positions, Math.max),
      },
      { bufferView: 0, byteOffset: 12, componentType: 5126, count: vertexCount, type: "VEC3" },
    );
  } else {
    writeFloatValues(binaryView, 0, positions);
    writeFloatValues(binaryView, positionBytes, normals);
    bufferViews.push(
      { buffer: 0, byteOffset: 0, byteLength: positionBytes, target: 34_962 },
      { buffer: 0, byteOffset: positionBytes, byteLength: normalBytes, target: 34_962 },
    );
    accessors.push(
      {
        bufferView: 0,
        componentType: 5126,
        count: vertexCount,
        type: "VEC3",
        min: componentBounds(positions, Math.min),
        max: componentBounds(positions, Math.max),
      },
      { bufferView: 1, componentType: 5126, count: vertexCount, type: "VEC3" },
    );
  }

  if (componentType === 5123) {
    for (let index = 0; index < indices.length; index += 1) {
      binaryView.setUint16(indexOffset + index * 2, indices[index] ?? 0, true);
    }
  } else {
    for (let index = 0; index < indices.length; index += 1) {
      binaryView.setUint32(indexOffset + index * 4, indices[index] ?? 0, true);
    }
  }
  const indexBufferView = bufferViews.length;
  bufferViews.push({
    buffer: 0,
    byteOffset: indexOffset,
    byteLength: indices.length * indexComponentBytes,
    target: 34_963,
  });
  accessors.push({
    bufferView: indexBufferView,
    componentType,
    count: indices.length,
    type: "SCALAR",
  });

  const document: FixtureDocument = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: binaryByteLength }],
    bufferViews,
    accessors,
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0, NORMAL: 1 },
            indices: 2,
            mode: 4,
          },
        ],
      },
    ],
  };
  options.mutateDocument?.(document);

  const json = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = align4(json.byteLength);
  const binaryLength = align4(binary.byteLength);
  const binChunkBytes = options.omitBinChunk === true ? 0 : 8 + binaryLength;
  const unknownChunkBytes = options.trailingUnknownChunk === true ? 12 : 0;
  const totalLength = 12 + 8 + jsonLength + binChunkBytes + unknownChunkBytes;
  const glb = new ArrayBuffer(totalLength);
  const glbView = new DataView(glb);
  const glbBytes = new Uint8Array(glb);
  glbView.setUint32(0, 0x4654_6c67, true);
  glbView.setUint32(4, 2, true);
  glbView.setUint32(8, totalLength, true);
  glbView.setUint32(12, jsonLength, true);
  glbView.setUint32(16, JSON_CHUNK, true);
  glbBytes.fill(0x20, 20, 20 + jsonLength);
  glbBytes.set(json, 20);
  const binaryOffset = 20 + jsonLength + 8;
  if (options.omitBinChunk !== true) {
    glbView.setUint32(20 + jsonLength, binaryLength, true);
    glbView.setUint32(24 + jsonLength, BIN_CHUNK, true);
    glbBytes.set(new Uint8Array(binary), binaryOffset);
  }
  if (options.trailingUnknownChunk === true) {
    const unknownOffset = 20 + jsonLength + binChunkBytes;
    glbView.setUint32(unknownOffset, 4, true);
    glbView.setUint32(unknownOffset + 4, 0x1234_5678, true);
    glbView.setUint32(unknownOffset + 8, 0xfeed_beef, true);
  }
  return { buffer: glb, binaryOffset, document };
}

function writeFloatValues(view: DataView, byteOffset: number, values: readonly number[]): void {
  for (let index = 0; index < values.length; index += 1) {
    view.setFloat32(byteOffset + index * 4, values[index] ?? 0, true);
  }
}

function componentBounds(
  values: readonly number[],
  operation: (left: number, right: number) => number,
): [number, number, number] {
  const result: [number, number, number] = [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0];
  for (let index = 3; index < values.length; index += 3) {
    result[0] = operation(result[0], values[index] ?? 0);
    result[1] = operation(result[1], values[index + 1] ?? 0);
    result[2] = operation(result[2], values[index + 2] ?? 0);
  }
  return result.map(Math.fround) as [number, number, number];
}

function align4(value: number): number {
  return (value + 3) & ~3;
}
