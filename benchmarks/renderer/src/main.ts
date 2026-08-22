import { createEngine, type MeshHandle } from "@lume/api";

declare global {
  interface Window {
    __LUME_BENCHMARK_RESULT__?: unknown;
  }
  interface Performance {
    readonly memory?: { readonly usedJSHeapSize: number };
  }
  interface Navigator {
    readonly deviceMemory?: number;
  }
}

const canvas = document.querySelector<HTMLCanvasElement>("#viewport");
const output = document.querySelector<HTMLPreElement>("#results");
if (canvas === null || output === null) throw new Error("Benchmark markup is incomplete.");

const parameters = new URLSearchParams(location.search);
const count = Math.max(1, Number(parameters.get("count") ?? 10_000));
const wasmUrl = parameters.get("wasmUrl") ?? undefined;
const wasmProfile = parameters.get("wasmProfile") ?? "workspace-default";
const benchmarkCommit = parameters.get("commit") ?? "unknown";
const updateRatio = Math.min(1, Math.max(0, Number(parameters.get("updateRatio") ?? 0)));
const warmupFrames = 60;
const sampleFrames = 180;
const side = Math.ceil(Math.sqrt(count));

const engine = createEngine({
  canvas,
  ...(wasmUrl === undefined ? {} : { wasmUrl }),
  entityCapacity: count + 2,
  autoResize: false,
  powerPreference: "high",
  camera: {
    position: [0, 0, Math.max(3, side * 1.15)],
    near: 0.1,
    far: Math.max(100, side * 3),
  },
});
const blue = engine.create.basicMaterial({ color: [0.31, 0.56, 1, 1] });
const meshes = new Array<MeshHandle>(count);
for (let index = 0; index < count; index += 1) {
  const x = (index % side) - side * 0.5;
  const y = Math.floor(index / side) - side * 0.5;
  meshes[index] = engine.create.mesh({
    geometry: "cube",
    material: blue,
    position: [x * 1.2, y * 1.2, 0],
  });
}
const updatedEntities = Math.floor(count * updateRatio);

const initializationStart = performance.now();
await engine.init();
engine.start();
const initializationMs = performance.now() - initializationStart;
const firstFrameStart = performance.now();
await nextAnimationFrame();
await engine.getStats();
const firstRenderedFrameMs = performance.now() - firstFrameStart;
for (let frame = 0; frame < warmupFrames; frame += 1) await nextAnimationFrame();

const frameTimesMs: number[] = [];
const cpuTimesMs: number[] = [];
const uploadTimesMs: number[] = [];
const preparationTimesMs: number[] = [];
const uploadBytes: number[] = [];
const bufferWriteCounts: number[] = [];
for (let frame = 0; frame < sampleFrames; frame += 1) {
  updateTransforms(frame);
  await nextAnimationFrame();
  const stats = await engine.getStats();
  frameTimesMs.push(stats.frameTime);
  cpuTimesMs.push(stats.cpuTime);
  uploadTimesMs.push(stats.timings.bufferUploadCpuTime);
  preparationTimesMs.push(stats.timings.framePreparationCpuTime);
  uploadBytes.push(stats.timings.bufferUploadBytes);
  bufferWriteCounts.push(stats.timings.bufferWriteCount);
}
const stats = await engine.getStats();
const gpuAdapter = await readGpuAdapterInfo();
const report = {
  schemaVersion: 1,
  engine: "lume",
  engineVersion: "0.2.0",
  scenario: "static_indexed_cubes",
  commit: benchmarkCommit,
  hardware: {
    userAgent: navigator.userAgent,
    logicalCores: navigator.hardwareConcurrency,
    deviceMemoryGiB: navigator.deviceMemory ?? null,
    gpuAdapter,
  },
  browser: navigator.userAgent,
  configuration: {
    entities: count,
    resolution: [1280, 720],
    warmupFrames,
    sampleFrames,
    powerPreference: "high",
    wasmProfile,
    updateRatio,
    updatedEntities,
  },
  measurements: {
    initializationMs,
    webGpuSetupMs: initializationMs,
    firstRenderedFrameMs,
    frameTimesMs,
    cpuTimesMs,
    bufferUploadCpuTimesMs: uploadTimesMs,
    framePreparationCpuTimesMs: preparationTimesMs,
    cpuStageTimings: stats.timings.cpuStages,
    bufferUploadBytes: uploadBytes,
    bufferWriteCounts,
    jsHeapBytes: performance.memory?.usedJSHeapSize ?? null,
    gpuFrameTimeMs: stats.gpuTime,
    gpuBufferBytes: stats.memory.gpuBuffers,
    wasmHeapBytes: stats.memory.wasmHeap,
    workerJsHeapBytes: stats.memory.jsHeap,
    bundleTransferBytes: resourceTransferBytes(),
    drawCalls: stats.render.drawCalls,
    visibleObjects: stats.render.visibleObjects,
    allocationsPerFrame: stats.allocationsPerFrame,
  },
};
window.__LUME_BENCHMARK_RESULT__ = report;
output.textContent = JSON.stringify(report, null, 2);

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function updateTransforms(frame: number): void {
  for (let index = 0; index < updatedEntities; index += 1) {
    const x = (index % side) - side * 0.5;
    const y = Math.floor(index / side) - side * 0.5;
    engine.set.transform(meshes[index] as MeshHandle, {
      position: [x * 1.2, y * 1.2, Math.sin(frame * 0.01 + index * 0.001) * 0.1],
    });
  }
}

function resourceTransferBytes(): number {
  let total = 0;
  for (const entry of performance.getEntriesByType("resource")) {
    total += (entry as PerformanceResourceTiming).transferSize;
  }
  return total;
}

async function readGpuAdapterInfo(): Promise<Record<string, string | number | boolean> | null> {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (adapter === null) return null;
  const info = adapter.info;
  return {
    vendor: info.vendor,
    architecture: info.architecture,
    device: info.device,
    description: info.description,
    isFallbackAdapter: info.isFallbackAdapter,
    ...(info.subgroupMinSize === undefined ? {} : { subgroupMinSize: info.subgroupMinSize }),
    ...(info.subgroupMaxSize === undefined ? {} : { subgroupMaxSize: info.subgroupMaxSize }),
  };
}
