import { type BasicMaterialHandle, createEngine } from "@lume/api";
import { decodeGlbGeometry, type GlbIndexComponentType } from "@lume/assets";

interface FixtureScenario {
  readonly name: string;
  readonly class: "small" | "medium" | "large";
  readonly url: string;
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly indexComponentType: GlbIndexComponentType;
  readonly encodedBytes: number;
  readonly decodedBytes: number;
  readonly decodeSamples: number;
  readonly loadSamples: number;
}

interface FixtureManifest {
  readonly scenarios: readonly FixtureScenario[];
}

interface ScenarioResult {
  readonly fixture: FixtureScenario;
  readonly directDecodeMs: readonly number[];
  readonly promiseLatencyMs: readonly number[];
  readonly workerTimings: readonly NonNullable<AssetStats["latestLoadTimings"]>[];
  readonly accounting: {
    readonly peakTemporaryReservedBytes: number;
    readonly retainedDecodedBytes: number;
    readonly residentGpuBytes: number;
    readonly cleanupRetainedDecodedBytes: number;
    readonly cleanupResidentGpuBytes: number;
  };
  readonly steadyState: {
    readonly allocationsPerFrame: number;
    readonly assetRelatedMessageDelta: number;
    readonly bufferUploadBytes: number;
    readonly bufferWriteCount: number;
  };
}

interface BenchmarkResult {
  readonly userAgent: string;
  readonly gpu: {
    readonly vendor: string;
    readonly architecture: string;
    readonly device: string;
    readonly description: string;
  } | null;
  readonly crossOriginIsolated: boolean;
  readonly scenarios: readonly ScenarioResult[];
}

type Engine = ReturnType<typeof createEngine>;
type AssetStats = Awaited<ReturnType<Engine["getStats"]>>["assets"];

declare global {
  interface Window {
    __LUME_ASSET_BENCHMARK_RESULT__: Promise<BenchmarkResult>;
  }
}

const status = document.querySelector<HTMLOutputElement>("#status");
if (status === null) throw new Error("Asset benchmark markup is incomplete.");
const statusOutput = status;

window.__LUME_ASSET_BENCHMARK_RESULT__ = runBenchmark();

async function runBenchmark(): Promise<BenchmarkResult> {
  const manifest = await fetch("/generated/manifest.json").then(async (response) => {
    if (!response.ok) throw new Error(`Fixture manifest request failed (${response.status}).`);
    return (await response.json()) as FixtureManifest;
  });
  const results: ScenarioResult[] = [];
  for (const scenario of manifest.scenarios) {
    const { engine, canvas } = createScenarioEngine(scenario);
    const material = engine.create.basicMaterial({ color: [0.2, 0.7, 1, 1] });
    try {
      await engine.init();
      engine.start();
      statusOutput.textContent = `Running ${scenario.name}…`;
      results.push(await measureScenario(engine, material, scenario));
    } finally {
      engine.dispose();
      canvas.remove();
    }
  }
  const adapter = await navigator.gpu.requestAdapter();
  const adapterInfo = adapter?.info;
  statusOutput.textContent = "Asset benchmark complete";
  return {
    userAgent: navigator.userAgent,
    gpu:
      adapterInfo === undefined
        ? null
        : {
            vendor: adapterInfo.vendor,
            architecture: adapterInfo.architecture,
            device: adapterInfo.device,
            description: adapterInfo.description,
          },
    crossOriginIsolated,
    scenarios: results,
  };
}

function createScenarioEngine(scenario: FixtureScenario): {
  readonly engine: Engine;
  readonly canvas: HTMLCanvasElement;
} {
  const temporaryBytes = Math.max(
    scenario.encodedBytes * 2,
    scenario.encodedBytes + scenario.decodedBytes,
  );
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  document.body.append(canvas);
  const engine = createEngine({
    canvas,
    entityCapacity: 8,
    resourceCapacity: 8,
    geometryLimits: {
      decode: {
        maxEncodedBytes: scenario.encodedBytes,
        maxDecodedBytes: scenario.decodedBytes,
        maxVertices: scenario.vertexCount,
        maxIndices: scenario.indexCount,
      },
      maxTemporaryBytes: temporaryBytes,
      maxRetainedDecodedBytes: scenario.decodedBytes,
      maxResidentGpuBytes: scenario.decodedBytes,
    },
    camera: { position: [0, 0, 4], near: 0.1, far: 20 },
    visibilityMode: "cpu",
    autoResize: false,
  });
  return { engine, canvas };
}

async function measureScenario(
  engine: Engine,
  material: BasicMaterialHandle,
  scenario: FixtureScenario,
): Promise<ScenarioResult> {
  const encoded = await fetch(scenario.url).then(async (response) => {
    if (!response.ok) throw new Error(`${scenario.name} request failed (${response.status}).`);
    return response.arrayBuffer();
  });
  if (encoded.byteLength !== scenario.encodedBytes) throw new Error("Encoded accounting mismatch.");
  const limits = {
    maxEncodedBytes: scenario.encodedBytes,
    maxDecodedBytes: scenario.decodedBytes,
    maxVertices: scenario.vertexCount,
    maxIndices: scenario.indexCount,
  };
  for (let warmup = 0; warmup < 3; warmup += 1) decodeGlbGeometry(encoded, limits);
  const directDecodeMs: number[] = [];
  for (let sample = 0; sample < scenario.decodeSamples; sample += 1) {
    const startedAt = performance.now();
    const decoded = decodeGlbGeometry(encoded, limits);
    directDecodeMs.push(performance.now() - startedAt);
    assertDescriptor(decoded, scenario);
  }

  const promiseLatencyMs: number[] = [];
  const workerTimings: NonNullable<AssetStats["latestLoadTimings"]>[] = [];
  let peakTemporaryReservedBytes = 0;
  let retainedDecodedBytes = 0;
  let residentGpuBytes = 0;
  let cleanupRetainedDecodedBytes = 0;
  let cleanupResidentGpuBytes = 0;
  let steadyState: ScenarioResult["steadyState"] | undefined;
  for (let sample = 0; sample < scenario.loadSamples; sample += 1) {
    const startedAt = performance.now();
    const geometry = await engine.load.geometry(scenario.url);
    promiseLatencyMs.push(performance.now() - startedAt);
    const loaded = await engine.getStats();
    const timings = loaded.assets.latestLoadTimings;
    if (timings === null) throw new Error("Successful load did not publish timing diagnostics.");
    workerTimings.push(timings);
    peakTemporaryReservedBytes = Math.max(
      peakTemporaryReservedBytes,
      loaded.assets.peakTemporaryReservedBytes,
    );
    retainedDecodedBytes = loaded.assets.retainedDecodedBytes;
    residentGpuBytes = loaded.assets.residentGpuBytes;
    if (
      retainedDecodedBytes !== scenario.decodedBytes ||
      residentGpuBytes !== scenario.decodedBytes
    ) {
      throw new Error(`${scenario.name} retained accounting did not match decoded bytes.`);
    }
    const mesh = engine.create.mesh({
      geometry,
      material,
      position: [0, 0, -4],
      bounds: { radius: 2 },
    });
    await waitForFrames();
    await engine.getStats();
    await waitForFrames();
    const steadyA = await engine.getStats();
    await waitForFrames();
    const steadyB = await engine.getStats();
    steadyState = {
      allocationsPerFrame: steadyB.allocationsPerFrame,
      assetRelatedMessageDelta: steadyB.transport.messages - steadyA.transport.messages - 1,
      bufferUploadBytes: steadyB.timings.bufferUploadBytes,
      bufferWriteCount: steadyB.timings.bufferWriteCount,
    };
    engine.destroy(mesh);
    engine.destroy(geometry);
    const cleanup = await engine.getStats();
    cleanupRetainedDecodedBytes = cleanup.assets.retainedDecodedBytes;
    cleanupResidentGpuBytes = cleanup.assets.residentGpuBytes;
    if (cleanupRetainedDecodedBytes !== 0 || cleanupResidentGpuBytes !== 0) {
      throw new Error(`${scenario.name} retained memory did not return to zero.`);
    }
  }
  if (steadyState === undefined) throw new Error("Scenario requires at least one load sample.");
  return {
    fixture: scenario,
    directDecodeMs,
    promiseLatencyMs,
    workerTimings,
    accounting: {
      peakTemporaryReservedBytes,
      retainedDecodedBytes,
      residentGpuBytes,
      cleanupRetainedDecodedBytes,
      cleanupResidentGpuBytes,
    },
    steadyState,
  };
}

function assertDescriptor(
  decoded: ReturnType<typeof decodeGlbGeometry>,
  scenario: FixtureScenario,
): void {
  if (
    decoded.vertexCount !== scenario.vertexCount ||
    decoded.indexCount !== scenario.indexCount ||
    decoded.sourceIndexComponentType !== scenario.indexComponentType ||
    decoded.bytes.decodedBytes !== scenario.decodedBytes
  ) {
    throw new Error(`${scenario.name} decoded descriptor did not match its fixture manifest.`);
  }
}

function waitForFrames(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 80));
}
