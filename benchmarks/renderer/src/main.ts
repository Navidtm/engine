import { boxGeometry, camera, createEngine, material, mesh, transform } from "@lume/api";

declare global {
  interface Window { __LUME_BENCHMARK_RESULT__?: unknown; }
  interface Performance { readonly memory?: { readonly usedJSHeapSize: number }; }
  interface Navigator { readonly deviceMemory?: number; }
}

const canvas = document.querySelector<HTMLCanvasElement>("#viewport");
const output = document.querySelector<HTMLPreElement>("#results");
if (canvas === null || output === null) throw new Error("Benchmark markup is incomplete.");

const parameters = new URLSearchParams(location.search);
const count = Math.max(1, Number(parameters.get("count") ?? 10_000));
const warmupFrames = 60;
const sampleFrames = 180;

const engine = createEngine({
  canvas,
  wasmUrl: "/lume_core.wasm",
  entityCapacity: count + 2,
  autoResize: false,
  powerPreference: "high-performance",
});
const materialEntity = engine.world.createEntity();
engine.world.add(materialEntity, material({ color: [0.31, 0.56, 1, 1] }));
const side = Math.ceil(Math.sqrt(count));
for (let index = 0; index < count; index += 1) {
  const entity = engine.world.createEntity();
  const x = (index % side) - side * 0.5;
  const y = Math.floor(index / side) - side * 0.5;
  engine.world.add(entity, transform({ position: [x * 1.2, y * 1.2, 0] }));
  engine.world.add(entity, mesh(boxGeometry(), materialEntity));
}
const cameraEntity = engine.world.createEntity();
engine.world.add(cameraEntity, transform({ position: [0, 0, Math.max(3, side * 1.15)] }));
engine.world.add(cameraEntity, camera({ near: 0.1, far: Math.max(100, side * 3) }));

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
for (let frame = 0; frame < sampleFrames; frame += 1) {
  await nextAnimationFrame();
  const stats = await engine.getStats();
  frameTimesMs.push(stats.frameTimeMs);
  cpuTimesMs.push(stats.cpuTimeMs);
  uploadTimesMs.push(stats.bufferUploadCpuTimeMs);
  preparationTimesMs.push(stats.framePreparationCpuTimeMs);
}
const stats = await engine.getStats();
const report = {
  schemaVersion: 1,
  engine: "lume",
  engineVersion: "0.2.0",
  scenario: "static_indexed_cubes",
  hardware: {
    userAgent: navigator.userAgent,
    logicalCores: navigator.hardwareConcurrency,
    deviceMemoryGiB: navigator.deviceMemory ?? null,
  },
  browser: navigator.userAgent,
  configuration: {
    entities: count,
    resolution: [1280, 720],
    warmupFrames,
    sampleFrames,
    powerPreference: "high-performance",
  },
  measurements: {
    initializationMs,
    webGpuSetupMs: initializationMs,
    firstRenderedFrameMs,
    frameTimesMs,
    cpuTimesMs,
    bufferUploadCpuTimesMs: uploadTimesMs,
    framePreparationCpuTimesMs: preparationTimesMs,
    jsHeapBytes: performance.memory?.usedJSHeapSize ?? null,
    gpuBufferBytes: stats.gpuBufferBytes,
    wasmHeapBytes: stats.wasmHeapBytes,
    workerJsHeapBytes: stats.jsHeapBytes,
    bundleTransferBytes: resourceTransferBytes(),
    drawCalls: stats.drawCalls,
    allocationsPerFrame: stats.allocationsPerFrame,
  },
};
window.__LUME_BENCHMARK_RESULT__ = report;
output.textContent = JSON.stringify(report, null, 2);

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function resourceTransferBytes(): number {
  let total = 0;
  for (const entry of performance.getEntriesByType("resource")) {
    total += (entry as PerformanceResourceTiming).transferSize;
  }
  return total;
}
