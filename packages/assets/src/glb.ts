import { AssetError } from "./errors.js";
import { defineGeometryDecodeLimits, type GeometryDecodeLimits } from "./limits.js";
import type { DecodedGeometry, GeometryBounds, GlbIndexComponentType } from "./types.js";

const GLB_MAGIC = 0x4654_6c67;
const GLB_VERSION = 2;
const JSON_CHUNK = 0x4e4f_534a;
const BIN_CHUNK = 0x004e_4942;
const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34_962;
const ELEMENT_ARRAY_BUFFER = 34_963;
const ATTRIBUTE_ELEMENT_BYTES = 12;
const OUTPUT_VERTEX_BYTES = 24;
const MAX_VERTEX_STRIDE = 252;
const COMPRESSION_EXTENSIONS = new Set(["KHR_draco_mesh_compression", "EXT_meshopt_compression"]);

type JsonRecord = Record<string, unknown>;

interface GlbContainer {
  readonly jsonBytes: Uint8Array<ArrayBuffer>;
  readonly binaryOffset: number;
  readonly binaryLength: number;
}

interface AccessorView {
  readonly offset: number;
  readonly stride: number;
  readonly count: number;
  readonly componentType: number;
  readonly min: readonly number[] | undefined;
  readonly max: readonly number[] | undefined;
}

interface ParsedGeometry {
  readonly positions: AccessorView;
  readonly normals: AccessorView;
  readonly indices: AccessorView;
  readonly sourceIndexComponentType: GlbIndexComponentType;
}

/**
 * Decodes the constrained, geometry-only GLB 2.0 profile from ADR 011.
 *
 * This operation is pure with respect to engine state: it performs no fetch,
 * ECS, renderer, WebGPU, or worker communication work.
 */
export function decodeGlbGeometry(
  input: ArrayBuffer,
  requestedLimits: GeometryDecodeLimits,
): DecodedGeometry {
  if (!(input instanceof ArrayBuffer)) {
    throw new TypeError("decodeGlbGeometry requires an ArrayBuffer.");
  }
  const limits = defineGeometryDecodeLimits(requestedLimits);
  if (input.byteLength > limits.maxEncodedBytes) {
    budgetExceeded(
      `Encoded GLB size ${input.byteLength} exceeds the ${limits.maxEncodedBytes}-byte request limit.`,
    );
  }

  const container = parseContainer(input);
  const document = parseDocument(container.jsonBytes);
  const geometry = validateGeometryDocument(document, container, input, limits);
  const vertexBytes = checkedMultiply(
    geometry.positions.count,
    OUTPUT_VERTEX_BYTES,
    "vertex bytes",
  );
  const indexBytes = checkedMultiply(geometry.indices.count, 4, "decoded index bytes");
  const decodedBytes = checkedAdd(vertexBytes, indexBytes, "decoded geometry bytes");
  if (decodedBytes > limits.maxDecodedBytes) {
    budgetExceeded(
      `Decoded geometry size ${decodedBytes} exceeds the ${limits.maxDecodedBytes}-byte request limit.`,
    );
  }
  const minimumPeakBytes = checkedAdd(input.byteLength, decodedBytes, "minimum peak bytes");

  let interleavedVertices: Float32Array<ArrayBuffer>;
  let indices: Uint32Array<ArrayBuffer>;
  try {
    interleavedVertices = new Float32Array(geometry.positions.count * 6);
    indices = new Uint32Array(geometry.indices.count);
  } catch {
    budgetExceeded("Decoded geometry arrays could not be allocated within platform limits.");
  }

  const source = new DataView(input);
  const bounds = decodeAttributes(source, container.binaryOffset, geometry, interleavedVertices);
  decodeIndices(source, container.binaryOffset, geometry, indices);

  return {
    interleavedVertices,
    indices,
    vertexCount: geometry.positions.count,
    indexCount: geometry.indices.count,
    sourceIndexComponentType: geometry.sourceIndexComponentType,
    bounds,
    bytes: {
      encodedBytes: input.byteLength,
      vertexBytes,
      indexBytes,
      decodedBytes,
      minimumPeakBytes,
    },
  };
}

function parseContainer(input: ArrayBuffer): GlbContainer {
  if (input.byteLength < 20)
    format("container", "GLB is too short to contain a header and JSON chunk.");
  const view = new DataView(input);
  if (view.getUint32(0, true) !== GLB_MAGIC) format("container", "Invalid GLB magic.");
  if (view.getUint32(4, true) !== GLB_VERSION) {
    unsupported("container", "Only GLB container version 2 is supported.");
  }
  const declaredLength = view.getUint32(8, true);
  if (declaredLength !== input.byteLength) {
    format("container", "GLB declared length does not match the supplied buffer length.");
  }

  let offset = 12;
  let chunkIndex = 0;
  let jsonOffset = -1;
  let jsonLength = 0;
  let binaryOffset = -1;
  let binaryLength = 0;
  while (offset < input.byteLength) {
    if (input.byteLength - offset < 8) format("container", "GLB has a truncated chunk header.");
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    if (chunkLength % 4 !== 0) format("container", "GLB chunk length is not 4-byte aligned.");
    const dataOffset = checkedAdd(offset, 8, "chunk data offset");
    const chunkEnd = checkedAdd(dataOffset, chunkLength, "chunk end");
    if (chunkEnd > input.byteLength) format("container", "GLB chunk exceeds the declared length.");

    if (chunkIndex === 0 && chunkType !== JSON_CHUNK) {
      format("container", "The first GLB chunk must be JSON.");
    }
    if (chunkType === JSON_CHUNK) {
      if (chunkIndex !== 0 || jsonOffset !== -1)
        format("container", "GLB contains an invalid JSON chunk order.");
      jsonOffset = dataOffset;
      jsonLength = chunkLength;
    } else if (chunkType === BIN_CHUNK) {
      if (chunkIndex !== 1 || binaryOffset !== -1) {
        format("container", "The GLB BIN chunk must occur at most once, immediately after JSON.");
      }
      binaryOffset = dataOffset;
      binaryLength = chunkLength;
    }

    offset = chunkEnd;
    chunkIndex += 1;
  }

  if (offset !== input.byteLength || jsonOffset < 0 || jsonLength === 0) {
    format("container", "GLB does not contain one complete JSON chunk.");
  }
  if (binaryOffset < 0 || binaryLength === 0) {
    format("container", "The constrained geometry profile requires one non-empty BIN chunk.");
  }
  return {
    jsonBytes: new Uint8Array(input, jsonOffset, jsonLength),
    binaryOffset,
    binaryLength,
  };
}

function parseDocument(jsonBytes: Uint8Array<ArrayBuffer>): JsonRecord {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(jsonBytes);
  } catch {
    format("json", "GLB JSON chunk is not valid UTF-8.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    format("json", "GLB JSON chunk is not valid JSON.");
  }
  return record(parsed, "glTF root");
}

function validateGeometryDocument(
  document: JsonRecord,
  container: GlbContainer,
  input: ArrayBuffer,
  limits: Readonly<GeometryDecodeLimits>,
): ParsedGeometry {
  const asset = record(document.asset, "asset");
  if (typeof asset.version !== "string") format("schema", "asset.version must be a string.");
  if (asset.version !== "2.0") unsupported("schema", "Only glTF asset version 2.0 is supported.");
  if (asset.minVersion !== undefined) {
    if (typeof asset.minVersion !== "string")
      format("schema", "asset.minVersion must be a string.");
    if (asset.minVersion !== "2.0")
      unsupported("schema", "The glTF minimum asset version is unsupported.");
  }

  const requiredExtensions = optionalStringArray(document, "extensionsRequired", "glTF root");
  if (requiredExtensions.length > 0) {
    unsupported(
      "schema",
      `Required glTF extension is unsupported: ${requiredExtensions[0] ?? "unknown"}.`,
    );
  }
  const usedExtensions = optionalStringArray(document, "extensionsUsed", "glTF root");
  const compressionExtension = usedExtensions.find((extension) =>
    COMPRESSION_EXTENSIONS.has(extension),
  );
  if (compressionExtension !== undefined) {
    unsupported(
      "geometry",
      `Runtime geometry compression is unsupported: ${compressionExtension}.`,
    );
  }

  rejectNonEmptyFeature(document, "animations");
  rejectNonEmptyFeature(document, "images");
  rejectNonEmptyFeature(document, "materials");
  rejectNonEmptyFeature(document, "samplers");
  rejectNonEmptyFeature(document, "skins");
  rejectNonEmptyFeature(document, "textures");

  const buffers = array(document.buffers, "buffers");
  if (buffers.length !== 1)
    unsupported("schema", "The constrained GLB profile requires exactly one buffer.");
  const buffer = record(buffers[0], "buffers[0]");
  if (Object.hasOwn(buffer, "uri"))
    unsupported("schema", "External or data-URI buffers are unsupported.");
  const declaredBufferLength = requiredSafeInteger(buffer, "byteLength", "buffers[0]", 1);
  if (
    container.binaryLength < declaredBufferLength ||
    container.binaryLength > checkedAdd(declaredBufferLength, 3, "BIN padding")
  ) {
    format("schema", "BIN chunk length is incompatible with buffers[0].byteLength.");
  }
  const bytes = new Uint8Array(input);
  for (
    let paddingOffset = container.binaryOffset + declaredBufferLength;
    paddingOffset < container.binaryOffset + container.binaryLength;
    paddingOffset += 1
  ) {
    if (bytes[paddingOffset] !== 0)
      format("container", "BIN chunk padding must contain zero bytes.");
  }

  const accessors = array(document.accessors, "accessors");
  const bufferViews = array(document.bufferViews, "bufferViews");
  const meshes = array(document.meshes, "meshes");
  if (meshes.length !== 1) unsupported("geometry", "Exactly one glTF mesh is required.");
  const mesh = record(meshes[0], "meshes[0]");
  if (Object.hasOwn(mesh, "weights")) unsupported("geometry", "Morph weights are unsupported.");
  rejectExtensions(mesh, "meshes[0]");
  const primitives = array(mesh.primitives, "meshes[0].primitives");
  if (primitives.length !== 1) unsupported("geometry", "Exactly one mesh primitive is required.");
  const primitive = record(primitives[0], "meshes[0].primitives[0]");
  if (primitive.mode !== undefined) {
    const mode = safeInteger(primitive.mode, "meshes[0].primitives[0].mode", 0);
    if (mode !== 4) unsupported("geometry", "Only triangle-list primitive mode 4 is supported.");
  }
  if (Object.hasOwn(primitive, "material"))
    unsupported("geometry", "Materials are outside the geometry-only profile.");
  if (Object.hasOwn(primitive, "targets"))
    unsupported("geometry", "Morph targets are unsupported.");
  rejectExtensions(primitive, "meshes[0].primitives[0]");

  const attributes = record(primitive.attributes, "meshes[0].primitives[0].attributes");
  const attributeNames = Object.keys(attributes);
  if (
    attributeNames.length !== 2 ||
    !Object.hasOwn(attributes, "POSITION") ||
    !Object.hasOwn(attributes, "NORMAL")
  ) {
    unsupported("geometry", "Exactly POSITION and NORMAL attributes are required.");
  }
  const positionIndex = safeIndex(attributes.POSITION, accessors.length, "POSITION accessor");
  const normalIndex = safeIndex(attributes.NORMAL, accessors.length, "NORMAL accessor");
  const indexIndex = safeIndex(primitive.indices, accessors.length, "indices accessor");

  const positions = parseAccessor(
    accessors,
    bufferViews,
    positionIndex,
    "POSITION",
    FLOAT,
    "VEC3",
    declaredBufferLength,
    container.binaryLength,
    true,
  );
  const normals = parseAccessor(
    accessors,
    bufferViews,
    normalIndex,
    "NORMAL",
    FLOAT,
    "VEC3",
    declaredBufferLength,
    container.binaryLength,
    false,
  );
  const indexAccessorRecord = record(accessors[indexIndex], `accessors[${indexIndex}]`);
  const indexComponentType = indexAccessorRecord.componentType;
  if (typeof indexComponentType !== "number" || !Number.isSafeInteger(indexComponentType)) {
    format("schema", `accessors[${indexIndex}].componentType must be a safe integer.`);
  }
  if (indexComponentType !== UNSIGNED_SHORT && indexComponentType !== UNSIGNED_INT) {
    unsupported("geometry", "Indices must use UNSIGNED_SHORT or UNSIGNED_INT components.");
  }
  const indices = parseAccessor(
    accessors,
    bufferViews,
    indexIndex,
    "indices",
    indexComponentType,
    "SCALAR",
    declaredBufferLength,
    container.binaryLength,
    false,
  );

  if (positions.count !== normals.count)
    format("geometry", "POSITION and NORMAL counts must match.");
  if (indices.count % 3 !== 0)
    format("geometry", "Triangle-list index count must be non-zero and divisible by 3.");
  if (positions.count > limits.maxVertices) {
    budgetExceeded(
      `Vertex count ${positions.count} exceeds the ${limits.maxVertices}-vertex request limit.`,
    );
  }
  if (indices.count > limits.maxIndices) {
    budgetExceeded(
      `Index count ${indices.count} exceeds the ${limits.maxIndices}-index request limit.`,
    );
  }

  return {
    positions,
    normals,
    indices,
    sourceIndexComponentType: indexComponentType,
  };
}

function parseAccessor(
  accessors: readonly unknown[],
  bufferViews: readonly unknown[],
  accessorIndex: number,
  label: string,
  expectedComponentType: number,
  expectedType: "SCALAR" | "VEC3",
  declaredBufferLength: number,
  binaryLength: number,
  requireBounds: boolean,
): AccessorView {
  const path = `accessors[${accessorIndex}]`;
  const accessor = record(accessors[accessorIndex], path);
  rejectExtensions(accessor, path);
  if (Object.hasOwn(accessor, "sparse"))
    unsupported("geometry", `${label} sparse accessors are unsupported.`);
  if (typeof accessor.componentType !== "number" || !Number.isSafeInteger(accessor.componentType)) {
    format("schema", `${path}.componentType must be a safe integer.`);
  }
  if (typeof accessor.type !== "string") format("schema", `${path}.type must be a string.`);
  if (accessor.componentType !== expectedComponentType || accessor.type !== expectedType) {
    unsupported(
      "geometry",
      `${label} must use ${expectedType} with component type ${expectedComponentType}.`,
    );
  }
  if (accessor.normalized !== undefined) {
    if (typeof accessor.normalized !== "boolean")
      format("schema", `${path}.normalized must be boolean.`);
    if (accessor.normalized)
      unsupported("geometry", `${label} normalized accessors are unsupported.`);
  }
  const count = requiredSafeInteger(accessor, "count", path, 1);
  const accessorByteOffset = optionalSafeInteger(accessor, "byteOffset", path, 0);
  const bufferViewIndex = safeIndex(accessor.bufferView, bufferViews.length, `${label} bufferView`);
  const viewPath = `bufferViews[${bufferViewIndex}]`;
  const bufferView = record(bufferViews[bufferViewIndex], viewPath);
  rejectExtensions(bufferView, viewPath);
  if (requiredSafeInteger(bufferView, "buffer", viewPath, 0) !== 0) {
    unsupported("schema", `${label} must reference the GLB-stored buffer.`);
  }
  const viewByteOffset = optionalSafeInteger(bufferView, "byteOffset", viewPath, 0);
  const viewByteLength = requiredSafeInteger(bufferView, "byteLength", viewPath, 1);
  const viewEnd = checkedAdd(viewByteOffset, viewByteLength, `${viewPath} end`);
  if (viewEnd > declaredBufferLength || viewEnd > binaryLength) {
    format("geometry", `${viewPath} exceeds the GLB-stored buffer.`);
  }

  const isAttribute = expectedType === "VEC3";
  const componentBytes = expectedComponentType === UNSIGNED_SHORT ? 2 : 4;
  const elementBytes = expectedType === "VEC3" ? ATTRIBUTE_ELEMENT_BYTES : componentBytes;
  let stride = elementBytes;
  if (bufferView.byteStride !== undefined) {
    if (!isAttribute) unsupported("geometry", "Index bufferViews must not define byteStride.");
    stride = safeInteger(bufferView.byteStride, `${viewPath}.byteStride`, 4);
    if (stride > MAX_VERTEX_STRIDE || stride % 4 !== 0 || stride < elementBytes) {
      format("geometry", `${viewPath}.byteStride is invalid for ${label}.`);
    }
  }
  if (bufferView.target !== undefined) {
    const expectedTarget = isAttribute ? ARRAY_BUFFER : ELEMENT_ARRAY_BUFFER;
    if (bufferView.target !== expectedTarget)
      format("geometry", `${viewPath}.target does not match ${label} usage.`);
  }
  if (
    accessorByteOffset % componentBytes !== 0 ||
    checkedAdd(viewByteOffset, accessorByteOffset, `${label} absolute offset`) % componentBytes !==
      0 ||
    (isAttribute && (accessorByteOffset % 4 !== 0 || stride % 4 !== 0))
  ) {
    format("geometry", `${label} accessor alignment is invalid.`);
  }
  const elementSpan = checkedAdd(
    checkedMultiply(count - 1, stride, `${label} accessor stride span`),
    elementBytes,
    `${label} accessor element span`,
  );
  const accessorEnd = checkedAdd(accessorByteOffset, elementSpan, `${label} accessor end`);
  if (accessorEnd > viewByteLength) format("geometry", `${label} accessor exceeds its bufferView.`);

  const min = optionalFiniteNumberArray(accessor, "min", path, expectedType === "VEC3" ? 3 : 1);
  const max = optionalFiniteNumberArray(accessor, "max", path, expectedType === "VEC3" ? 3 : 1);
  if (requireBounds && (min === undefined || max === undefined)) {
    format("geometry", `${label} accessor requires min and max bounds.`);
  }
  return {
    offset: checkedAdd(viewByteOffset, accessorByteOffset, `${label} data offset`),
    stride,
    count,
    componentType: expectedComponentType,
    min,
    max,
  };
}

function decodeAttributes(
  source: DataView,
  binaryOffset: number,
  geometry: ParsedGeometry,
  output: Float32Array<ArrayBuffer>,
): GeometryBounds {
  const actualMin: [number, number, number] = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  ];
  const actualMax: [number, number, number] = [
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  for (let vertex = 0; vertex < geometry.positions.count; vertex += 1) {
    const positionOffset =
      binaryOffset + geometry.positions.offset + vertex * geometry.positions.stride;
    const normalOffset = binaryOffset + geometry.normals.offset + vertex * geometry.normals.stride;
    const outputOffset = vertex * 6;
    for (let component = 0; component < 3; component += 1) {
      const position = source.getFloat32(positionOffset + component * 4, true);
      const normal = source.getFloat32(normalOffset + component * 4, true);
      if (!Number.isFinite(position) || !Number.isFinite(normal)) {
        format("geometry", "POSITION and NORMAL values must be finite.");
      }
      output[outputOffset + component] = position;
      output[outputOffset + 3 + component] = normal;
      actualMin[component] = Math.min(actualMin[component] ?? position, position);
      actualMax[component] = Math.max(actualMax[component] ?? position, position);
    }
  }
  const declaredMin = geometry.positions.min;
  const declaredMax = geometry.positions.max;
  if (declaredMin === undefined || declaredMax === undefined) {
    format("geometry", "POSITION accessor bounds are missing.");
  }
  for (let component = 0; component < 3; component += 1) {
    if (
      Math.fround(declaredMin[component] ?? Number.NaN) !== actualMin[component] ||
      Math.fround(declaredMax[component] ?? Number.NaN) !== actualMax[component]
    ) {
      format("geometry", "POSITION accessor min/max do not match binary values.");
    }
  }
  return { min: actualMin, max: actualMax };
}

function decodeIndices(
  source: DataView,
  binaryOffset: number,
  geometry: ParsedGeometry,
  output: Uint32Array<ArrayBuffer>,
): void {
  const componentBytes = geometry.sourceIndexComponentType === UNSIGNED_SHORT ? 2 : 4;
  for (let index = 0; index < geometry.indices.count; index += 1) {
    const sourceOffset = binaryOffset + geometry.indices.offset + index * componentBytes;
    const value =
      geometry.sourceIndexComponentType === UNSIGNED_SHORT
        ? source.getUint16(sourceOffset, true)
        : source.getUint32(sourceOffset, true);
    if (value >= geometry.positions.count)
      format("geometry", "Geometry index exceeds the vertex count.");
    output[index] = value;
  }
}

function rejectNonEmptyFeature(document: JsonRecord, key: string): void {
  if (document[key] === undefined) return;
  const values = array(document[key], key);
  if (values.length > 0) unsupported("geometry", `${key} are outside the geometry-only profile.`);
}

function rejectExtensions(value: JsonRecord, path: string): void {
  if (value.extensions === undefined) return;
  const extensions = record(value.extensions, `${path}.extensions`);
  if (Object.keys(extensions).length > 0)
    unsupported("geometry", `${path} extensions are unsupported.`);
}

function optionalStringArray(document: JsonRecord, key: string, path: string): readonly string[] {
  if (document[key] === undefined) return [];
  const values = array(document[key], `${path}.${key}`);
  for (const value of values) {
    if (typeof value !== "string") format("schema", `${path}.${key} must contain strings.`);
  }
  return values as string[];
}

function optionalFiniteNumberArray(
  value: JsonRecord,
  key: string,
  path: string,
  length: number,
): readonly number[] | undefined {
  if (value[key] === undefined) return undefined;
  const values = array(value[key], `${path}.${key}`);
  if (
    values.length !== length ||
    values.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
  ) {
    format("schema", `${path}.${key} must contain ${length} finite numbers.`);
  }
  return values as number[];
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) format("schema", `${path} must be an array.`);
  return value;
}

function record(value: unknown, path: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    format("schema", `${path} must be an object.`);
  }
  return value as JsonRecord;
}

function safeIndex(value: unknown, length: number, path: string): number {
  const index = safeInteger(value, path, 0);
  if (index >= length) format("schema", `${path} is out of range.`);
  return index;
}

function requiredSafeInteger(
  value: JsonRecord,
  key: string,
  path: string,
  minimum: number,
): number {
  if (!Object.hasOwn(value, key)) format("schema", `${path}.${key} is required.`);
  return safeInteger(value[key], `${path}.${key}`, minimum);
}

function optionalSafeInteger(
  value: JsonRecord,
  key: string,
  path: string,
  fallback: number,
): number {
  if (!Object.hasOwn(value, key)) return fallback;
  return safeInteger(value[key], `${path}.${key}`, 0);
}

function safeInteger(value: unknown, path: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    format("schema", `${path} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return value;
}

function checkedMultiply(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result))
    format("schema", `Integer overflow while calculating ${label}.`);
  return result;
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result))
    format("schema", `Integer overflow while calculating ${label}.`);
  return result;
}

function format(stage: "container" | "json" | "schema" | "geometry", message: string): never {
  throw new AssetError("LUME_ASSET_FORMAT", stage, message);
}

function unsupported(stage: "container" | "schema" | "geometry", message: string): never {
  throw new AssetError("LUME_ASSET_UNSUPPORTED", stage, message);
}

function budgetExceeded(message: string): never {
  throw new AssetError("LUME_ASSET_BUDGET_EXCEEDED", "budget", message);
}
