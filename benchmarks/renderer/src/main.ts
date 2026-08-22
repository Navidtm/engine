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
const count = Math.max(0, Number(parameters.get("count") ?? 10_000));
const capacity = Math.max(count + 2, Number(parameters.get("capacity") ?? count + 2));
const wasmUrl = parameters.get("wasmUrl") ?? undefined;
const wasmProfile = parameters.get("wasmProfile") ?? "workspace-default";
const benchmarkCommit = parameters.get("commit") ?? "unknown";
const updateRatio = Math.min(1, Math.max(0, Number(parameters.get("updateRatio") ?? 0)));
const boundsUpdateRatio = ratioParameter("boundsUpdateRatio");
const resourceUpdateRatio = ratioParameter("resourceUpdateRatio");
const churnRatio = ratioParameter("churnRatio");
const visibleRatio = ratioParameter("visibleRatio", 1);
const visibilityMode =
  parameters.get("visibilityMode") === "gpu"
    ? "gpu"
    : parameters.get("visibilityMode") === "auto"
      ? "auto"
      : "cpu";
const cameraCount = Math.min(4, Math.max(1, Number(parameters.get("cameraCount") ?? 1)));
const layout = parameters.get("layout") === "random" ? "random" : "grid";
const seed = Number(parameters.get("seed") ?? 0x6c75_6d65) >>> 0;
const warmupFrames = 60;
const sampleFrames = 180;
const side = Math.max(1, Math.ceil(Math.sqrt(count)));

const engine = createEngine({
  canvas,
  ...(wasmUrl === undefined ? {} : { wasmUrl }),
  entityCapacity: capacity,
  autoResize: false,
  powerPreference: "high",
  visibilityMode,
  camera: {
    position: [0, 0, Math.max(3, side * 1.15)],
    near: 0.1,
    far: Math.max(100, side * 3),
  },
});
const blue = engine.create.basicMaterial({ color: [0.31, 0.56, 1, 1] });
const orange = engine.create.basicMaterial({ color: [1, 0.35, 0.08, 1] });
for (let index = 1; index < cameraCount; index += 1) {
  const camera = engine.world.createEntity();
  engine.world.add(camera, {
    kind: "transform",
    position: [index * 0.01, 0, Math.max(3, side * 1.15)],
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
  });
  engine.world.add(camera, {
    kind: "camera",
    verticalFov: Math.PI / 3,
    near: 0.1,
    far: Math.max(100, side * 3),
  });
}
const meshes = new Array<MeshHandle>(count);
const baseX = new Float32Array(count);
const baseY = new Float32Array(count);
const baseZ = new Float32Array(count);
const visibleCount = Math.floor(count * visibleRatio);
let randomState = seed || 1;
for (let index = 0; index < count; index += 1) {
  if (layout === "random") {
    baseX[index] = index < visibleCount ? (random() - 0.5) * side * 0.8 : side * 100;
    baseY[index] = (random() - 0.5) * side * 0.8;
    baseZ[index] = (random() - 0.5) * side * 0.2;
  } else {
    baseX[index] = index < visibleCount ? ((index % side) - side * 0.5) * 1.2 : side * 100;
    baseY[index] = (Math.floor(index / side) - side * 0.5) * 1.2;
  }
  meshes[index] = engine.create.mesh({
    geometry: "cube",
    material: blue,
    position: [baseX[index] ?? 0, baseY[index] ?? 0, baseZ[index] ?? 0],
    bounds: { radius: 0.75 },
  });
}
const updatedEntities = Math.floor(count * updateRatio);
const boundsUpdatedEntities = Math.floor(count * boundsUpdateRatio);
const resourceUpdatedEntities = Math.floor(count * resourceUpdateRatio);
const churnedEntities = Math.floor(count * churnRatio);

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
  updateBounds(frame);
  updateResources(frame);
  churnMeshes();
  await nextAnimationFrame();
  const stats = await engine.getStats();
  frameTimesMs.push(stats.frameTime);
  cpuTimesMs.push(stats.cpuTime);
  uploadTimesMs.push(stats.timings.bufferUploadCpuTime);
  preparationTimesMs.push(stats.timings.framePreparationCpuTime);
  uploadBytes.push(stats.timings.bufferUploadBytes);
  bufferWriteCounts.push(stats.timings.bufferWriteCount);
}
const stats = await readFinalStats();
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
    capacity,
    occupancy: count / capacity,
    resolution: [1280, 720],
    warmupFrames,
    sampleFrames,
    powerPreference: "high",
    wasmProfile,
    updateRatio,
    boundsUpdateRatio,
    resourceUpdateRatio,
    churnRatio,
    visibleRatio,
    visibilityMode,
    cameraCount,
    layout,
    seed,
    updatedEntities,
    boundsUpdatedEntities,
    resourceUpdatedEntities,
    churnedEntities,
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
    computeDispatches: stats.render.computeDispatches,
    indirectDrawCalls: stats.render.indirectDrawCalls,
    visibilityBackend: stats.render.visibilityBackend,
    gpuVisibleObjects: stats.render.gpuVisibleObjects,
    gpuVisibilityHash: stats.render.gpuVisibilityHash,
    cpuVisibilityHash: stats.render.cpuVisibilityHash,
    uploadBytesByDomain: stats.timings.uploadBytesByDomain,
    activeObjects: stats.render.extractedObjects,
    testedObjects: stats.render.extractedObjects,
    visibleObjects: stats.render.visibleObjects,
    allocationsPerFrame: stats.allocationsPerFrame,
  },
};
window.__LUME_BENCHMARK_RESULT__ = report;
output.textContent = JSON.stringify(report, null, 2);

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function updateBounds(frame: number): void {
  const radius = 0.75 + (frame & 1) * 0.01;
  for (let index = 0; index < boundsUpdatedEntities; index += 1) {
    engine.world.add(meshAt(index).id, { kind: "bounds", center: [0, 0, 0], radius });
  }
}

function updateResources(frame: number): void {
  const material = (frame & 1) === 0 ? blue : orange;
  for (let index = 0; index < resourceUpdatedEntities; index += 1) {
    engine.world.add(meshAt(index).id, {
      kind: "mesh",
      geometry: engine.geometry.cube,
      material,
    });
  }
}

function churnMeshes(): void {
  for (let index = 0; index < churnedEntities; index += 1) {
    engine.destroy(meshAt(index));
    meshes[index] = engine.create.mesh({
      geometry: "cube",
      material: blue,
      position: [baseX[index] ?? 0, baseY[index] ?? 0, baseZ[index] ?? 0],
      bounds: { radius: 0.75 },
    });
  }
}

function ratioParameter(name: string, fallback = 0): number {
  return Math.min(1, Math.max(0, Number(parameters.get(name) ?? fallback)));
}

function updateTransforms(frame: number): void {
  for (let index = 0; index < updatedEntities; index += 1) {
    engine.set.transform(meshAt(index), {
      position: [
        baseX[index] ?? 0,
        baseY[index] ?? 0,
        (baseZ[index] ?? 0) + Math.sin(frame * 0.01 + index * 0.001) * 0.1,
      ],
    });
  }
}

function meshAt(index: number): MeshHandle {
  const mesh = meshes[index];
  if (mesh === undefined) throw new Error(`Benchmark mesh ${index} is unavailable.`);
  return mesh;
}

function random(): number {
  randomState ^= randomState << 13;
  randomState ^= randomState >>> 17;
  randomState ^= randomState << 5;
  return (randomState >>> 0) / 0x1_0000_0000;
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

async function readFinalStats(): ReturnType<typeof engine.getStats> {
  let stats = await engine.getStats();
  if (visibilityMode !== "gpu") return stats;
  for (let frame = 0; frame < 120 && stats.render.gpuVisibleObjects === null; frame += 1) {
    await nextAnimationFrame();
    stats = await engine.getStats();
  }
  return stats;
}
