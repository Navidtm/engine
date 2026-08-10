import { createEngine, type MeshHandle } from "@lume/api";
import * as THREE from "three";
import WebGPURenderer from "three/src/renderers/webgpu/WebGPURenderer.js";

declare global {
  interface Window {
    __LUME_COMPARISON_RESULT__?: unknown;
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
const status = document.querySelector<HTMLElement>("#status");
const scenarioLabel = document.querySelector<HTMLElement>("#scenario");
const metrics = document.querySelector<HTMLElement>("#metrics");
const implementationSelect = document.querySelector<HTMLSelectElement>("#implementation");
const countSelect = document.querySelector<HTMLSelectElement>("#count");
const updateRatioSelect = document.querySelector<HTMLSelectElement>("#update-ratio");
const commitInput = document.querySelector<HTMLInputElement>("#commit");
if (
  canvas === null ||
  output === null ||
  status === null ||
  scenarioLabel === null ||
  metrics === null ||
  implementationSelect === null ||
  countSelect === null ||
  updateRatioSelect === null ||
  commitInput === null
) {
  throw new Error("Comparison markup is incomplete.");
}

const parameters = new URLSearchParams(location.search);
const implementation = parameters.get("implementation") === "three" ? "three" : "lume";
const updateRatio = validatedRatio(parameters.get("updateRatio") ?? "0");
const scenario = updateRatio === 0 ? "static" : "dynamic";
const benchmarkCommit = parameters.get("commit") ?? "unknown";
const defaultCount = updateRatio > 0 ? 50_000 : 10_000;
const count = validatedCount(parameters.get("count"), defaultCount);
const resolution = [1280, 720] as const;
const warmupFrames = 60;
const sampleFrames = 180;

implementationSelect.value = implementation;
countSelect.value = String(count);
updateRatioSelect.value = String(updateRatio);
commitInput.value = benchmarkCommit === "unknown" ? "" : benchmarkCommit;
scenarioLabel.textContent = `${implementation === "lume" ? "Lume" : "Three.js"} · ${count.toLocaleString()} entities · ${formatPercent(updateRatio)} updates`;

const environment = await collectEnvironment();
const displayRefreshIntervalMs = await measureDisplayRefreshInterval();
const report =
  implementation === "three"
    ? await runThree(canvas, scenario, count, updateRatio, environment, displayRefreshIntervalMs)
    : await runLume(canvas, scenario, count, updateRatio, environment, displayRefreshIntervalMs);
window.__LUME_COMPARISON_RESULT__ = report;
output.textContent = JSON.stringify(report, null, 2);
renderSummary(metrics, report);
status.textContent = "Benchmark complete";
status.dataset.status = "complete";

async function runLume(
  target: HTMLCanvasElement,
  selectedScenario: string,
  entities: number,
  selectedUpdateRatio: number,
  selectedEnvironment: BenchmarkEnvironment,
  selectedDisplayRefreshIntervalMs: number,
) {
  const side = Math.ceil(Math.sqrt(entities));
  const engine = createEngine({
    canvas: target,
    entityCapacity: entities + 2,
    autoResize: false,
    powerPreference: "high",
    camera: {
      position: [0, 0, Math.max(3, side * 1.15)],
      far: Math.max(100, side * 3),
    },
  });
  const blue = engine.create.basicMaterial({ color: [0.31, 0.56, 1, 1] });
  const entityHandles: MeshHandle[] = new Array(entities);
  for (let index = 0; index < entities; index += 1) {
    entityHandles[index] = engine.create.mesh({
      geometry: "cube",
      material: blue,
      position: gridPosition(index, side, 0),
    });
  }
  const startup = performance.now();
  await engine.init();
  engine.start();
  const initializationMs = performance.now() - startup;
  const firstFrameStart = performance.now();
  await nextAnimationFrame();
  await engine.getStats();
  const firstRenderedFrameMs = performance.now() - firstFrameStart;
  const updatedEntities = Math.floor(entities * selectedUpdateRatio);
  const samples = await sampleFramesWithUpdate(() => {
    if (updatedEntities === 0) return;
    const phase = performance.now() * 0.001;
    for (let index = 0; index < updatedEntities; index += 1) {
      const position = gridPosition(index, side, Math.sin(phase + index * 0.001) * 0.1);
      engine.set.transform(entityHandles[index] as MeshHandle, { position });
    }
  });
  const stats = await engine.getStats();
  return baseReport(
    "lume",
    selectedScenario,
    entities,
    selectedUpdateRatio,
    selectedEnvironment,
    selectedDisplayRefreshIntervalMs,
    initializationMs,
    samples,
    {
      gpuBufferBytes: stats.memory.gpuBuffers,
      drawCalls: stats.render.drawCalls,
      visibleObjects: stats.render.visibleObjects,
      gpuFrameTimeMs: stats.gpuTime,
      workerCpuTimeMs: stats.cpuTime,
      wasmHeapBytes: stats.memory.wasmHeap,
      workerJsHeapBytes: stats.memory.jsHeap,
      firstRenderedFrameMs,
    },
  );
}

async function runThree(
  target: HTMLCanvasElement,
  selectedScenario: string,
  entities: number,
  selectedUpdateRatio: number,
  selectedEnvironment: BenchmarkEnvironment,
  selectedDisplayRefreshIntervalMs: number,
) {
  const renderer = new WebGPURenderer({ canvas: target, antialias: false });
  renderer.setSize(resolution[0], resolution[1], false);
  const scene = new THREE.Scene();
  const side = Math.ceil(Math.sqrt(entities));
  const viewCamera = new THREE.PerspectiveCamera(
    60,
    resolution[0] / resolution[1],
    0.1,
    Math.max(100, side * 3),
  );
  viewCamera.position.z = Math.max(3, side * 1.15);
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const meshMaterial = new THREE.MeshBasicMaterial({ color: 0x4f8fff });
  const meshes: THREE.Mesh[] = new Array(entities);
  for (let index = 0; index < entities; index += 1) {
    const item = new THREE.Mesh(geometry, meshMaterial);
    const [x, y, z] = gridPosition(index, side, 0);
    item.position.set(x, y, z);
    meshes[index] = item;
    scene.add(item);
  }
  const startup = performance.now();
  await renderer.init();
  const initializationMs = performance.now() - startup;
  const firstFrameStart = performance.now();
  renderer.render(scene, viewCamera);
  const firstRenderedFrameMs = performance.now() - firstFrameStart;
  const updatedEntities = Math.floor(entities * selectedUpdateRatio);
  const samples = await sampleFramesWithUpdate(() => {
    if (updatedEntities > 0) {
      const phase = performance.now() * 0.001;
      for (let index = 0; index < updatedEntities; index += 1) {
        const item = meshes[index] as THREE.Mesh;
        item.position.z = Math.sin(phase + index * 0.001) * 0.1;
        item.rotation.y += 0.002;
      }
    }
    renderer.render(scene, viewCamera);
  });
  return baseReport(
    "three",
    selectedScenario,
    entities,
    selectedUpdateRatio,
    selectedEnvironment,
    selectedDisplayRefreshIntervalMs,
    initializationMs,
    samples,
    {
      gpuBufferBytes: null,
      drawCalls: renderer.info.render.calls,
      visibleObjects: null,
      gpuFrameTimeMs: null,
      workerCpuTimeMs: null,
      wasmHeapBytes: null,
      workerJsHeapBytes: null,
      firstRenderedFrameMs,
    },
  );
}

async function sampleFramesWithUpdate(update: () => void): Promise<number[]> {
  for (let frame = 0; frame < warmupFrames; frame += 1) {
    await nextAnimationFrame();
    update();
  }
  const samples: number[] = [];
  let previous = performance.now();
  for (let frame = 0; frame < sampleFrames; frame += 1) {
    await nextAnimationFrame();
    update();
    const now = performance.now();
    samples.push(now - previous);
    previous = now;
  }
  return samples;
}

function baseReport(
  engine: "lume" | "three",
  selectedScenario: string,
  entities: number,
  selectedUpdateRatio: number,
  selectedEnvironment: BenchmarkEnvironment,
  selectedDisplayRefreshIntervalMs: number,
  initializationMs: number,
  frameTimesMs: number[],
  extra: ComparisonMetrics,
) {
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    commit: benchmarkCommit,
    engine,
    engineVersion: engine === "lume" ? "0.2.0" : THREE.REVISION,
    scenario: selectedScenario,
    environment: selectedEnvironment,
    browser: navigator.userAgent,
    configuration: {
      entities,
      updateRatio: selectedUpdateRatio,
      updatedEntities: Math.floor(entities * selectedUpdateRatio),
      resolution,
      warmupFrames,
      sampleFrames,
      displayRefreshIntervalMs: selectedDisplayRefreshIntervalMs,
      geometry: "indexed unit cube",
    },
    measurements: {
      initializationMs,
      frameTimesMs,
      frameTimeSummaryMs: summarize(frameTimesMs),
      missedFrames: frameTimesMs.filter((value) => value > selectedDisplayRefreshIntervalMs * 1.5)
        .length,
      jsHeapBytes: performance.memory?.usedJSHeapSize ?? null,
      bundleTransferBytes: resourceTransferBytes(),
      ...extra,
    },
  };
}

type ComparisonReport = ReturnType<typeof baseReport>;

interface ComparisonMetrics {
  readonly gpuBufferBytes: number | null;
  readonly drawCalls: number | null;
  readonly visibleObjects: number | null;
  readonly gpuFrameTimeMs: number | null;
  readonly workerCpuTimeMs: number | null;
  readonly wasmHeapBytes: number | null;
  readonly workerJsHeapBytes: number | null;
  readonly firstRenderedFrameMs: number | null;
}

function renderSummary(target: HTMLElement, value: ComparisonReport): void {
  const summary = value.measurements.frameTimeSummaryMs;
  const cards: ReadonlyArray<readonly [string, string]> = [
    ["Mean frame", formatMilliseconds(summary.mean)],
    ["P95 frame", formatMilliseconds(summary.p95)],
    ["P99 frame", formatMilliseconds(summary.p99)],
    ["Missed frames", String(value.measurements.missedFrames)],
    ["Initialization", formatMilliseconds(value.measurements.initializationMs)],
    ["Draw calls", formatOptionalNumber(value.measurements.drawCalls)],
    ["GPU frame", formatOptionalMilliseconds(value.measurements.gpuFrameTimeMs)],
    ["Worker CPU", formatOptionalMilliseconds(value.measurements.workerCpuTimeMs)],
  ];
  const fragment = document.createDocumentFragment();
  for (const [name, metricValue] of cards) {
    const card = document.createElement("article");
    card.className = "metric";
    const label = document.createElement("p");
    label.className = "metric-name";
    label.textContent = name;
    const displayedValue = document.createElement("p");
    displayedValue.className = "metric-value";
    displayedValue.textContent = metricValue;
    card.append(label, displayedValue);
    fragment.append(card);
  }
  target.replaceChildren(fragment);
}

interface BenchmarkEnvironment {
  readonly userAgent: string;
  readonly platform: string;
  readonly logicalCores: number;
  readonly deviceMemoryGiB: number | null;
  readonly gpu: {
    readonly vendor: string;
    readonly architecture: string;
    readonly device: string;
    readonly description: string;
  } | null;
}

async function collectEnvironment(): Promise<BenchmarkEnvironment> {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
  const info = adapter?.info;
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    logicalCores: navigator.hardwareConcurrency,
    deviceMemoryGiB: navigator.deviceMemory ?? null,
    gpu:
      info === undefined
        ? null
        : {
            vendor: info.vendor,
            architecture: info.architecture,
            device: info.device,
            description: info.description,
          },
  };
}

function validatedRatio(value: string): number {
  const ratio = Number(value);
  if (![0, 0.01, 0.1, 1].includes(ratio)) {
    throw new RangeError("updateRatio must be one of 0, 0.01, 0.1, or 1.");
  }
  return ratio;
}

function validatedCount(value: string | null, fallback: number): number {
  const countValue = value === null ? fallback : Number(value);
  if (!Number.isSafeInteger(countValue) || countValue < 1 || countValue > 100_000) {
    throw new RangeError("count must be an integer between 1 and 100,000.");
  }
  return countValue;
}

async function measureDisplayRefreshInterval(): Promise<number> {
  const samples: number[] = [];
  let previous = performance.now();
  for (let frame = 0; frame < 30; frame += 1) {
    await nextAnimationFrame();
    const now = performance.now();
    samples.push(now - previous);
    previous = now;
  }
  return summarize(samples).p50;
}

function summarize(samples: readonly number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (value: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * value))] ?? 0;
  return {
    mean: samples.reduce((sum, sample) => sum + sample, 0) / Math.max(samples.length, 1),
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1) ?? 0,
  };
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatMilliseconds(value: number): string {
  return `${value.toFixed(2)} ms`;
}

function formatOptionalMilliseconds(value: number | null): string {
  return value === null ? "Unavailable" : formatMilliseconds(value);
}

function formatOptionalNumber(value: number | null): string {
  return value === null ? "Unavailable" : value.toLocaleString();
}

function gridPosition(index: number, side: number, z: number): readonly [number, number, number] {
  return [((index % side) - side * 0.5) * 1.2, (Math.floor(index / side) - side * 0.5) * 1.2, z];
}

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
