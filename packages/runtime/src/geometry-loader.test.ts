import { AssetError, type DecodedGeometry } from "@lume/assets";
import type { MeshRenderer } from "@lume/renderer";
import { describe, expect, it, vi } from "vitest";

import { createGeometryLoader, readGeometryResponse } from "./geometry-loader.js";
import { RUNTIME_PROTOCOL_VERSION, type WorkerToMainMessage } from "./protocol.js";
import { createResourceCoordinator } from "./resource-coordinator.js";

const LIMITS = {
  decode: {
    maxEncodedBytes: 256,
    maxDecodedBytes: 256,
    maxVertices: 16,
    maxIndices: 48,
  },
  maxTemporaryBytes: 1_024,
  maxRetainedDecodedBytes: 512,
  maxResidentGpuBytes: 2_048,
} as const;

function decodedGeometry(encodedBytes: number): DecodedGeometry {
  const interleavedVertices = new Float32Array([
    0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1,
  ]);
  const indices = new Uint32Array([0, 1, 2]);
  const decodedBytes = interleavedVertices.byteLength + indices.byteLength;
  return {
    interleavedVertices,
    indices,
    vertexCount: 3,
    indexCount: 3,
    sourceIndexComponentType: 5125,
    bounds: { min: [0, 0, 0], max: [1, 1, 0] },
    bytes: {
      encodedBytes,
      vertexBytes: interleavedVertices.byteLength,
      indexBytes: indices.byteLength,
      decodedBytes,
      minimumPeakBytes: encodedBytes + decodedBytes,
    },
  };
}

function renderer(): MeshRenderer {
  return {
    lost: new Promise<GPUDeviceLostInfo>(() => undefined),
    frameTimings: {
      bufferUploadCpuTimeMs: 0,
      renderPreparationCpuTimeMs: 0,
      commandEncodingCpuTimeMs: 0,
      queueSubmitCpuTimeMs: 0,
    },
    registerGeometry: vi.fn(),
    registerExternalGeometry: vi.fn(),
    removeGeometry: vi.fn(),
    registerBasicMaterial: vi.fn(),
    removeBasicMaterial: vi.fn(),
    execute: vi.fn(),
    resize: vi.fn(),
    stats: vi.fn(),
    dispose: vi.fn(),
  } satisfies MeshRenderer;
}

function response(marker = 0, byteLength = 32): Response {
  const bytes = new Uint8Array(byteLength);
  bytes[0] = marker;
  return new Response(bytes, { status: 200 });
}

describe("worker geometry loading transaction", () => {
  it("correlates concurrent success and decode failure without partial publication", async () => {
    const coordinator = createResourceCoordinator(8, 8, LIMITS);
    const target = renderer();
    const posted: WorkerToMainMessage[] = [];
    const loader = createGeometryLoader({
      coordinator,
      limits: LIMITS,
      fetch: vi.fn(async (source) => response(source.endsWith("bad.glb") ? 1 : 0)),
      acquireRenderer: vi.fn(async () => target),
      postMessage: (message) => posted.push(message),
      decode: (bytes) => {
        if (new Uint8Array(bytes)[0] === 1) {
          throw new AssetError("LUME_ASSET_FORMAT", "geometry", "fixture decode failed");
        }
        return decodedGeometry(bytes.byteLength);
      },
    });

    loader.load(loadMessage(1, 1, "https://assets.test/ok.glb"));
    loader.load(loadMessage(2, 2, "https://assets.test/bad.glb"));

    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(posted).toContainEqual(
      expect.objectContaining({ type: "geometry-ready", requestId: 1, handle: 1 }),
    );
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: "geometry-failed",
        requestId: 2,
        handle: 2,
        error: expect.objectContaining({ code: "LUME_ASSET_FORMAT", stage: "geometry" }),
      }),
    );
    expect(target.registerExternalGeometry).toHaveBeenCalledTimes(1);
    expect(coordinator.assetStats()).toMatchObject({
      pendingLoads: 0,
      successfulLoads: 1,
      failedLoads: 1,
      temporaryReservedBytes: 0,
    });
  });

  it("invalidates an aborted fetch before late completion and allows only the next generation", async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetchResult = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const coordinator = createResourceCoordinator(4, 4, LIMITS);
    const target = renderer();
    const posted: WorkerToMainMessage[] = [];
    const loader = createGeometryLoader({
      coordinator,
      limits: LIMITS,
      fetch: vi.fn(async () => fetchResult),
      acquireRenderer: vi.fn(async () => target),
      postMessage: (message) => posted.push(message),
      decode: (bytes) => decodedGeometry(bytes.byteLength),
    });

    loader.load(loadMessage(3, 1, "https://assets.test/late.glb"));
    loader.abort(abortMessage(3, 1));
    resolveFetch?.(response());

    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      type: "geometry-failed",
      requestId: 3,
      error: { code: "LUME_ASSET_ABORTED" },
    });
    expect(target.registerExternalGeometry).not.toHaveBeenCalled();
    expect(coordinator.assetStats()).toMatchObject({ pendingLoads: 0, abortedLoads: 1 });

    const nextTarget = renderer();
    const nextLoader = createGeometryLoader({
      coordinator,
      limits: LIMITS,
      fetch: vi.fn(async () => response()),
      acquireRenderer: vi.fn(async () => nextTarget),
      postMessage: (message) => posted.push(message),
      decode: (bytes) => decodedGeometry(bytes.byteLength),
    });
    nextLoader.load(loadMessage(4, (1 << 20) | 1, "https://assets.test/current.glb"));
    await vi.waitFor(() =>
      expect(posted).toContainEqual(
        expect.objectContaining({ type: "geometry-ready", requestId: 4 }),
      ),
    );
    expect(nextTarget.registerExternalGeometry).toHaveBeenCalledWith(
      (1 << 20) | 1,
      expect.any(Object),
    );
  });

  it("aborts at the decode yield before decoder or renderer publication", async () => {
    const coordinator = createResourceCoordinator(4, 4, LIMITS);
    const target = renderer();
    const posted: WorkerToMainMessage[] = [];
    const decode = vi.fn((bytes: ArrayBuffer) => decodedGeometry(bytes.byteLength));
    const loader = createGeometryLoader({
      coordinator,
      limits: LIMITS,
      fetch: vi.fn(async () => response()),
      acquireRenderer: vi.fn(async () => target),
      postMessage: (message) => posted.push(message),
      decode,
    });

    loader.load(loadMessage(9, 1, "https://assets.test/decode-abort.glb"));
    for (let turn = 0; turn < 20; turn += 1) {
      if (coordinator.assetStats().temporaryReservedBytes === 288) break;
      await Promise.resolve();
    }
    expect(coordinator.assetStats()).toMatchObject({
      pendingLoads: 1,
      temporaryReservedBytes: 288,
    });

    loader.abort(abortMessage(9, 1));

    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      type: "geometry-failed",
      requestId: 9,
      handle: 1,
      error: { code: "LUME_ASSET_ABORTED", stage: "lifecycle" },
    });
    expect(decode).not.toHaveBeenCalled();
    expect(target.registerExternalGeometry).not.toHaveBeenCalled();
    expect(coordinator.assetStats()).toMatchObject({
      pendingLoads: 0,
      abortedLoads: 1,
      temporaryReservedBytes: 0,
    });
  });

  it("waits across renderer recovery and publishes to the replacement only", async () => {
    let resolveRenderer: ((value: MeshRenderer) => void) | undefined;
    const rendererResult = new Promise<MeshRenderer>((resolve) => {
      resolveRenderer = resolve;
    });
    const coordinator = createResourceCoordinator(4, 4, LIMITS);
    const replacement = renderer();
    const posted: WorkerToMainMessage[] = [];
    const loader = createGeometryLoader({
      coordinator,
      limits: LIMITS,
      fetch: vi.fn(async () => response()),
      acquireRenderer: vi.fn(async () => rendererResult),
      postMessage: (message) => posted.push(message),
      decode: (bytes) => decodedGeometry(bytes.byteLength),
    });

    loader.load(loadMessage(5, 1, "https://assets.test/recovery.glb"));
    await vi.waitFor(() => expect(coordinator.assetStats().pendingLoads).toBe(1));
    expect(posted).toEqual([]);
    resolveRenderer?.(replacement);

    await vi.waitFor(() => expect(posted[0]?.type).toBe("geometry-ready"));
    expect(replacement.registerExternalGeometry).toHaveBeenCalledWith(1, expect.any(Object));
  });

  it("aborts pending work and suppresses late results when the loader is disposed", async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetchResult = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const coordinator = createResourceCoordinator(4, 4, LIMITS);
    const target = renderer();
    const posted: WorkerToMainMessage[] = [];
    const loader = createGeometryLoader({
      coordinator,
      limits: LIMITS,
      fetch: vi.fn(async () => fetchResult),
      acquireRenderer: vi.fn(async () => target),
      postMessage: (message) => posted.push(message),
      decode: (bytes) => decodedGeometry(bytes.byteLength),
    });

    loader.load(loadMessage(8, 1, "https://assets.test/disposed.glb"));
    loader.dispose();
    resolveFetch?.(response());

    await vi.waitFor(() => expect(coordinator.assetStats().pendingLoads).toBe(0));
    expect(coordinator.assetStats().abortedLoads).toBe(1);
    expect(target.registerExternalGeometry).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  it("maps renderer failure and protocol mismatch to correlated typed failures", async () => {
    const coordinator = createResourceCoordinator(4, 4, LIMITS);
    const target = renderer();
    vi.mocked(target.registerExternalGeometry).mockImplementation(() => {
      throw new Error("device allocation failed");
    });
    const posted: WorkerToMainMessage[] = [];
    const fetch = vi.fn(async () => response());
    const loader = createGeometryLoader({
      coordinator,
      limits: LIMITS,
      fetch,
      acquireRenderer: vi.fn(async () => target),
      postMessage: (message) => posted.push(message),
      decode: (bytes) => decodedGeometry(bytes.byteLength),
    });

    loader.load({ ...loadMessage(6, 1, "https://assets.test/upload.glb"), protocolVersion: 999 });
    loader.load(loadMessage(7, 1, "https://assets.test/upload.glb"));

    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: "geometry-failed",
        requestId: 6,
        error: expect.objectContaining({ code: "LUME_ASSET_UNSUPPORTED", stage: "request" }),
      }),
    );
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: "geometry-failed",
        requestId: 7,
        error: expect.objectContaining({ code: "LUME_ASSET_GPU_UPLOAD", stage: "upload" }),
      }),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(coordinator.assetStats()).toMatchObject({ pendingLoads: 0, failedLoads: 1 });
  });
});

describe("bounded geometry response reading", () => {
  it("rejects declared and streamed bytes beyond the configured limit", async () => {
    const signal = new AbortController().signal;
    await expect(
      readGeometryResponse(
        new Response(new Uint8Array(8), { headers: { "content-length": "9" } }),
        8,
        signal,
      ),
    ).rejects.toMatchObject({ code: "LUME_ASSET_BUDGET_EXCEEDED" });

    await expect(readGeometryResponse(response(0, 9), 8, signal)).rejects.toMatchObject({
      code: "LUME_ASSET_BUDGET_EXCEEDED",
    });
  });
});

function loadMessage(requestId: number, handle: number, source: string) {
  return {
    type: "load-geometry" as const,
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    requestId,
    handle,
    source,
  };
}

function abortMessage(requestId: number, handle: number) {
  return {
    type: "abort-geometry-load" as const,
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    requestId,
    handle,
  };
}
