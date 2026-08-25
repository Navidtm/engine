import { describe, expect, it } from "vitest";

import { AssetError, isAssetError } from "./errors.js";
import { decodeGlbGeometry } from "./glb.js";
import { defineGeometryDecodeLimits, type GeometryDecodeLimits } from "./limits.js";
import { createGlbFixture, type FixtureDocument } from "./testing/glb-fixture.js";

const TEST_LIMITS = defineGeometryDecodeLimits({
  maxEncodedBytes: 1_048_576,
  maxDecodedBytes: 1_048_576,
  maxVertices: 10_000,
  maxIndices: 30_000,
});

describe("GLB geometry decoder", () => {
  it("decodes tightly packed UNSIGNED_SHORT geometry and accounts owned bytes", () => {
    const fixture = createGlbFixture();
    const decoded = decodeGlbGeometry(fixture.buffer, TEST_LIMITS);

    expect([...decoded.interleavedVertices]).toEqual([
      0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1,
    ]);
    expect([...decoded.indices]).toEqual([0, 1, 2]);
    expect(decoded).toMatchObject({
      vertexCount: 3,
      indexCount: 3,
      sourceIndexComponentType: 5123,
      bytes: {
        encodedBytes: fixture.buffer.byteLength,
        vertexBytes: 72,
        indexBytes: 12,
        decodedBytes: 84,
        minimumPeakBytes: fixture.buffer.byteLength + 84,
      },
    });
  });

  it("decodes valid strided attributes and UNSIGNED_INT indices", () => {
    const fixture = createGlbFixture({ interleavedAttributes: true, indexComponentType: 5125 });
    const decoded = decodeGlbGeometry(fixture.buffer, TEST_LIMITS);

    expect(decoded.sourceIndexComponentType).toBe(5125);
    expect([...decoded.interleavedVertices]).toEqual([
      0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1,
    ]);
    expect([...decoded.indices]).toEqual([0, 1, 2]);
  });

  it("ignores aligned unknown chunks after JSON and BIN as required by GLB 2.0", () => {
    const decoded = decodeGlbGeometry(
      createGlbFixture({ trailingUnknownChunk: true }).buffer,
      TEST_LIMITS,
    );
    expect([...decoded.indices]).toEqual([0, 1, 2]);
  });

  it("accepts one accessor referenced by both required attribute semantics", () => {
    const fixture = createGlbFixture({
      mutateDocument(document) {
        firstPrimitive(document).attributes.NORMAL = 0;
      },
    });
    const decoded = decodeGlbGeometry(fixture.buffer, TEST_LIMITS);
    expect([...decoded.interleavedVertices.slice(0, 6)]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("requires explicit positive safe-integer limits and snapshots them", () => {
    const source = {
      maxEncodedBytes: 100,
      maxDecodedBytes: 200,
      maxVertices: 10,
      maxIndices: 30,
    };
    const limits = defineGeometryDecodeLimits(source);
    source.maxEncodedBytes = 1;
    expect(limits.maxEncodedBytes).toBe(100);
    expect(Object.isFrozen(limits)).toBe(true);
    expect(() => defineGeometryDecodeLimits({ ...source, maxIndices: 0 })).toThrow(RangeError);
    expect(() =>
      defineGeometryDecodeLimits({ ...source, maxDecodedBytes: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow(RangeError);
  });

  it("rejects containers exceeding the encoded-byte budget before parsing", () => {
    const fixture = createGlbFixture();
    expectDecodeFailure(
      fixture.buffer,
      { ...TEST_LIMITS, maxEncodedBytes: 1 },
      "LUME_ASSET_BUDGET_EXCEEDED",
      "budget",
    );
  });

  const containerCases: ReadonlyArray<
    readonly [string, (fixture: ReturnType<typeof createGlbFixture>) => void, string, string]
  > = [
    [
      "invalid magic",
      ({ buffer }) => new DataView(buffer).setUint32(0, 0, true),
      "LUME_ASSET_FORMAT",
      "container",
    ],
    [
      "unsupported container version",
      ({ buffer }) => new DataView(buffer).setUint32(4, 1, true),
      "LUME_ASSET_UNSUPPORTED",
      "container",
    ],
    [
      "mismatched declared length",
      ({ buffer }) => new DataView(buffer).setUint32(8, buffer.byteLength - 4, true),
      "LUME_ASSET_FORMAT",
      "container",
    ],
    [
      "non-JSON first chunk",
      ({ buffer }) => new DataView(buffer).setUint32(16, 0x004e_4942, true),
      "LUME_ASSET_FORMAT",
      "container",
    ],
    [
      "chunk beyond declared bounds",
      ({ buffer }) => new DataView(buffer).setUint32(12, 0xffff_fffc, true),
      "LUME_ASSET_FORMAT",
      "container",
    ],
    [
      "invalid JSON UTF-8",
      ({ buffer }) => new Uint8Array(buffer).set([0xff], 20),
      "LUME_ASSET_FORMAT",
      "json",
    ],
    [
      "invalid JSON syntax",
      ({ buffer }) => new Uint8Array(buffer).set([0x78], 20),
      "LUME_ASSET_FORMAT",
      "json",
    ],
  ];

  it.each(containerCases)("rejects %s", (_name, mutate, code, stage) => {
    const fixture = createGlbFixture();
    mutate(fixture);
    expectDecodeFailure(fixture.buffer, TEST_LIMITS, code, stage);
  });

  it("rejects a missing BIN chunk", () => {
    expectDecodeFailure(
      createGlbFixture({ omitBinChunk: true }).buffer,
      TEST_LIMITS,
      "LUME_ASSET_FORMAT",
      "container",
    );
  });

  it("rejects non-zero BIN padding", () => {
    const fixture = createGlbFixture();
    new Uint8Array(fixture.buffer)[fixture.buffer.byteLength - 1] = 1;
    expectDecodeFailure(fixture.buffer, TEST_LIMITS, "LUME_ASSET_FORMAT", "container");
  });

  const unsupportedDocumentCases: ReadonlyArray<
    readonly [string, (document: FixtureDocument) => void]
  > = [
    ["non-2.0 asset versions", (document) => (document.asset.version = "1.0")],
    [
      "unknown required extensions",
      (document) => (document.extensionsRequired = ["VENDOR_unknown"]),
    ],
    [
      "runtime compression extensions",
      (document) => (document.extensionsUsed = ["EXT_meshopt_compression"]),
    ],
    ["material arrays", (document) => (document.materials = [{}])],
    [
      "external buffer URIs",
      (document) => (requiredItem(document.buffers, 0, "buffer").uri = "geometry.bin"),
    ],
    ["multiple buffers", (document) => document.buffers.push({ byteLength: 4 })],
    ["multiple meshes", (document) => document.meshes.push({ primitives: [] })],
    [
      "multiple primitives",
      (document) =>
        requiredItem(document.meshes, 0, "mesh").primitives.push({
          attributes: { POSITION: 0, NORMAL: 1 },
          indices: 2,
        }),
    ],
    ["non-triangle topology", (document) => (firstPrimitive(document).mode = 5)],
    ["materials on primitives", (document) => (firstPrimitive(document).material = 0)],
    ["morph targets", (document) => (firstPrimitive(document).targets = [])],
    [
      "additional vertex attributes",
      (document) => (firstPrimitive(document).attributes.TEXCOORD_0 = 0),
    ],
    [
      "sparse accessors",
      (document) => (requiredItem(document.accessors, 0, "accessor").sparse = {}),
    ],
    [
      "normalized attributes",
      (document) => (requiredItem(document.accessors, 0, "accessor").normalized = true),
    ],
    [
      "8-bit indices",
      (document) => (requiredItem(document.accessors, 2, "accessor").componentType = 5121),
    ],
    [
      "strided index data",
      (document) => (requiredItem(document.bufferViews, 2, "bufferView").byteStride = 4),
    ],
  ];

  it.each(unsupportedDocumentCases)("rejects unsupported %s", (_name, mutate) => {
    const fixture = createGlbFixture({ mutateDocument: mutate });
    expectDecodeFailure(fixture.buffer, TEST_LIMITS, "LUME_ASSET_UNSUPPORTED");
  });

  const malformedDocumentCases: ReadonlyArray<
    readonly [string, (document: FixtureDocument) => void]
  > = [
    ["non-string asset versions", (document) => (document.asset.version = 2)],
    ["missing indices", (document) => delete firstPrimitive(document).indices],
    [
      "out-of-range accessor references",
      (document) => (firstPrimitive(document).attributes.POSITION = 99),
    ],
    [
      "mismatched attribute counts",
      (document) => (requiredItem(document.accessors, 1, "accessor").count = 2),
    ],
    [
      "non-divisible triangle index counts",
      (document) => (requiredItem(document.accessors, 2, "accessor").count = 2),
    ],
    [
      "missing POSITION bounds",
      (document) => delete requiredItem(document.accessors, 0, "accessor").min,
    ],
    [
      "incorrect POSITION bounds",
      (document) => (requiredItem(document.accessors, 0, "accessor").max = [2, 1, 0]),
    ],
    [
      "bufferView bounds overflow",
      (document) => (requiredItem(document.bufferViews, 0, "bufferView").byteLength = 1_000_000),
    ],
    [
      "unsafe accessor counts",
      (document) =>
        (requiredItem(document.accessors, 0, "accessor").count = Number.MAX_SAFE_INTEGER),
    ],
    [
      "misaligned accessor offsets",
      (document) => (requiredItem(document.accessors, 0, "accessor").byteOffset = 2),
    ],
    [
      "incorrect bufferView targets",
      (document) => (requiredItem(document.bufferViews, 0, "bufferView").target = 34_963),
    ],
  ];

  it.each(malformedDocumentCases)("rejects malformed %s", (_name, mutate) => {
    const fixture = createGlbFixture({ mutateDocument: mutate });
    expectDecodeFailure(fixture.buffer, TEST_LIMITS, "LUME_ASSET_FORMAT");
  });

  it("rejects attributes sharing a bufferView without an explicit stride", () => {
    const fixture = createGlbFixture({
      interleavedAttributes: true,
      mutateDocument(document) {
        delete requiredItem(document.bufferViews, 0, "bufferView").byteStride;
      },
    });
    expectDecodeFailure(fixture.buffer, TEST_LIMITS, "LUME_ASSET_FORMAT", "geometry");
  });

  it("rejects non-finite attribute data", () => {
    const fixture = createGlbFixture();
    new DataView(fixture.buffer).setFloat32(fixture.binaryOffset, Number.NaN, true);
    expectDecodeFailure(fixture.buffer, TEST_LIMITS, "LUME_ASSET_FORMAT", "geometry");
  });

  it("rejects indices outside the vertex range", () => {
    const fixture = createGlbFixture();
    const indexOffset = Number(
      requiredItem(fixture.document.bufferViews, 2, "bufferView").byteOffset,
    );
    new DataView(fixture.buffer).setUint16(fixture.binaryOffset + indexOffset, 3, true);
    expectDecodeFailure(fixture.buffer, TEST_LIMITS, "LUME_ASSET_FORMAT", "geometry");
  });

  const budgetCases: ReadonlyArray<readonly [string, Partial<GeometryDecodeLimits>]> = [
    ["vertex count", { maxVertices: 2 }],
    ["index count", { maxIndices: 2 }],
    ["decoded bytes", { maxDecodedBytes: 83 }],
  ];

  it.each(budgetCases)("rejects %s budget exhaustion", (_name, override) => {
    const fixture = createGlbFixture();
    expectDecodeFailure(
      fixture.buffer,
      { ...TEST_LIMITS, ...override },
      "LUME_ASSET_BUDGET_EXCEEDED",
      "budget",
    );
  });
});

function firstPrimitive(document: FixtureDocument) {
  const mesh = requiredItem(document.meshes, 0, "mesh");
  return requiredItem(mesh.primitives, 0, "primitive");
}

function requiredItem<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Fixture is missing ${label} ${index}.`);
  return value;
}

function expectDecodeFailure(
  source: ArrayBuffer,
  limits: GeometryDecodeLimits,
  code: string,
  stage?: string,
): void {
  try {
    decodeGlbGeometry(source, limits);
    expect.fail("Expected GLB decode to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(AssetError);
    expect(isAssetError(error)).toBe(true);
    expect(error).toMatchObject(stage === undefined ? { code } : { code, stage });
  }
}
