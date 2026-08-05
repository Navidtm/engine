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
if (canvas === null || output === null) throw new Error("Comparison markup is incomplete.");

const parameters = new URLSearchParams(location.search);
const implementation = parameters.get("implementation") === "three" ? "three" : "lume";
const scenario = parameters.get("scenario") ?? "static";
const defaultCount = scenario === "dynamic" ? 50_000 : scenario === "large" ? 100_000 : 10_000;
const count = Math.max(1, Number(parameters.get("count") ?? defaultCount));
const resolution = [1280, 720] as const;
const warmupFrames = 60;
const sampleFrames = 180;

const report =
  implementation === "three"
    ? await runThree(canvas, scenario, count)
    : await runLume(canvas, scenario, count);
window.__LUME_COMPARISON_RESULT__ = report;
output.textContent = JSON.stringify(report, null, 2);

async function runLume(target: HTMLCanvasElement, selectedScenario: string, entities: number) {
  const engine = createEngine({
    canvas: target,
    wasmUrl: "/lume_core.wasm",
    entityCapacity: entities + 2,
    autoResize: false,
    powerPreference: "high",
  });
  const blue = engine.create.basicMaterial({ color: [0.31, 0.56, 1, 1] });
  const entityHandles: MeshHandle[] = new Array(entities);
  const side = Math.ceil(Math.sqrt(entities));
  for (let index = 0; index < entities; index += 1) {
    entityHandles[index] = engine.create.mesh({
      geometry: "cube",
      material: blue,
      position: gridPosition(index, side, 0),
    });
  }
  engine.create.perspectiveCamera({
    position: [0, 0, Math.max(3, side * 1.15)],
    far: Math.max(100, side * 3),
  });
  const startup = performance.now();
  await engine.init();
  engine.start();
  const initializationMs = performance.now() - startup;
  const firstFrameStart = performance.now();
  await nextAnimationFrame();
  await engine.getStats();
  const firstRenderedFrameMs = performance.now() - firstFrameStart;
  const samples = await sampleFramesWithUpdate(() => {
    if (selectedScenario !== "dynamic") return;
    const phase = performance.now() * 0.001;
    for (let index = 0; index < entities; index += 1) {
      const position = gridPosition(index, side, Math.sin(phase + index * 0.001) * 0.1);
      engine.set.transform(entityHandles[index] as MeshHandle, { position });
    }
  });
  const stats = await engine.getStats();
  return baseReport("lume", selectedScenario, entities, initializationMs, samples, {
    gpuBufferBytes: stats.memory.gpuBuffers,
    drawCalls: stats.render.drawCalls,
    visibleObjects: stats.render.visibleObjects,
    gpuFrameTimeMs: stats.gpuTime,
    workerCpuTimeMs: stats.cpuTime,
    wasmHeapBytes: stats.memory.wasmHeap,
    workerJsHeapBytes: stats.memory.jsHeap,
    firstRenderedFrameMs,
  });
}

async function runThree(target: HTMLCanvasElement, selectedScenario: string, entities: number) {
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
  const samples = await sampleFramesWithUpdate(() => {
    if (selectedScenario === "dynamic") {
      const phase = performance.now() * 0.001;
      for (let index = 0; index < entities; index += 1) {
        const item = meshes[index] as THREE.Mesh;
        item.position.z = Math.sin(phase + index * 0.001) * 0.1;
        item.rotation.y += 0.002;
      }
    }
    renderer.render(scene, viewCamera);
  });
  return baseReport("three", selectedScenario, entities, initializationMs, samples, {
    gpuBufferBytes: null,
    drawCalls: renderer.info.render.calls,
    workerCpuTimeMs: null,
    wasmHeapBytes: null,
    workerJsHeapBytes: null,
    firstRenderedFrameMs,
  });
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
  initializationMs: number,
  frameTimesMs: number[],
  extra: Record<string, number | null>,
) {
  return {
    schemaVersion: 1,
    engine,
    engineVersion: engine === "lume" ? "0.2.0" : THREE.REVISION,
    scenario: selectedScenario,
    hardware: {
      userAgent: navigator.userAgent,
      logicalCores: navigator.hardwareConcurrency,
      deviceMemoryGiB: navigator.deviceMemory ?? null,
    },
    browser: navigator.userAgent,
    configuration: {
      entities,
      resolution,
      warmupFrames,
      sampleFrames,
      geometry: "indexed unit cube",
    },
    measurements: {
      initializationMs,
      frameTimesMs,
      jsHeapBytes: performance.memory?.usedJSHeapSize ?? null,
      bundleTransferBytes: resourceTransferBytes(),
      ...extra,
    },
  };
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
