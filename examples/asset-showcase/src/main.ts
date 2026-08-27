import "./style.css";

import { createEngine, GeometryLoadError, type MeshHandle } from "@lume/api";

interface ShowcaseResult {
  readonly status: "ready" | "error";
  readonly encodedBytes: number;
  readonly retainedDecodedBytes: number;
  readonly visibilityBackend: "cpu" | "gpu";
  readonly message: string;
}

declare global {
  interface Window {
    __LUME_ASSET_SHOWCASE_RESULT__: Promise<ShowcaseResult>;
  }
}

const elements = requireElements();
const MEBIBYTE = 1_048_576;
const engine = createEngine({
  canvas: elements.canvas,
  entityCapacity: 160,
  resourceCapacity: 16,
  componentCapacities: { transforms: 160, meshRenderers: 160, bounds: 160, cameras: 0 },
  transport: { transformCapacity: 160, structuralCommandCapacity: 96 },
  geometryLimits: {
    decode: {
      maxEncodedBytes: 6 * MEBIBYTE,
      maxDecodedBytes: 8 * MEBIBYTE,
      maxVertices: 100_000,
      maxIndices: 600_000,
    },
    maxTemporaryBytes: 16 * MEBIBYTE,
    maxRetainedDecodedBytes: 12 * MEBIBYTE,
    maxResidentGpuBytes: 12 * MEBIBYTE,
  },
  visibilityMode: "gpu",
  powerPreference: "high",
  camera: { position: [0, 0, 6], verticalFov: (55 * Math.PI) / 180, near: 0.1, far: 120 },
  clearColor: { r: 0.008, g: 0.012, b: 0.03, a: 1 },
  onError(error) {
    setError(error.message);
  },
});

const cyan = engine.create.basicMaterial({ color: [0.08, 0.72, 1, 1] });
const violet = engine.create.basicMaterial({ color: [0.58, 0.24, 1, 1] });
const amber = engine.create.basicMaterial({ color: [1, 0.48, 0.12, 1] });
const background = engine.create.basicMaterial({ color: [0.08, 0.12, 0.22, 1] });
const cubes: MeshHandle[] = [];
for (let index = 0; index < 72; index += 1) {
  const angle = (index / 72) * Math.PI * 2;
  const radius = 4.4 + (index % 3) * 0.55;
  cubes.push(
    engine.create.mesh({
      geometry: "cube",
      material: background,
      position: [Math.cos(angle) * radius, Math.sin(angle) * radius * 0.58, -9 - (index % 4)],
      scale: [0.09, 0.09, 0.09],
      bounds: { radius: 0.18 },
    }),
  );
}

let hero: MeshHandle | undefined;
let running = true;
let animationFrame = 0;
let statsTimer = 0;
let animationStart = performance.now();

window.__LUME_ASSET_SHOWCASE_RESULT__ = run();

async function run(): Promise<ShowcaseResult> {
  try {
    await engine.init();
    const loadStartedAt = performance.now();
    const geometry = await engine.load.geometry("/assets/wave-grid.glb");
    const promiseLatencyMs = performance.now() - loadStartedAt;
    hero = engine.create.mesh({
      geometry,
      material: cyan,
      position: [0, 0, -5.5],
      scale: [1.65, 1.65, 1.65],
      bounds: { radius: 2.4 },
    });
    engine.create.mesh({
      geometry,
      material: violet,
      position: [-3.1, -0.35, -8],
      scale: [1.1, 1.1, 1.1],
      bounds: { radius: 1.7 },
    });
    engine.create.mesh({
      geometry,
      material: amber,
      position: [3.1, -0.35, -8],
      scale: [1.1, 1.1, 1.1],
      bounds: { radius: 1.7 },
    });
    engine.start();
    animationStart = performance.now();
    animate(animationStart);
    const stats = await engine.getStats();
    renderStats(stats, promiseLatencyMs);
    elements.status.textContent = "Ready — decoded, uploaded, instanced, and animated";
    elements.status.dataset.state = "ready";
    statsTimer = window.setInterval(() => void refreshStats(), 1_000);
    return {
      status: "ready",
      encodedBytes: stats.assets.fetchedEncodedBytes,
      retainedDecodedBytes: stats.assets.retainedDecodedBytes,
      visibilityBackend: stats.render.visibilityBackend,
      message: elements.status.textContent,
    };
  } catch (error) {
    const message = formatError(error);
    setError(message);
    return {
      status: "error",
      encodedBytes: 0,
      retainedDecodedBytes: 0,
      visibilityBackend: "cpu",
      message,
    };
  }
}

function animate(now: number): void {
  const elapsed = (now - animationStart) / 1_000;
  const target = hero;
  if (target !== undefined) {
    const halfAngle = Math.sin(elapsed * 0.35) * 0.18;
    engine.set.transform(target, {
      position: [0, Math.sin(elapsed * 0.8) * 0.14, -5.5],
      rotation: [0, Math.sin(halfAngle), 0, Math.cos(halfAngle)],
    });
  }
  animationFrame = requestAnimationFrame(animate);
}

async function refreshStats(): Promise<void> {
  if (engine.status !== "running" && engine.status !== "stopped") return;
  try {
    renderStats(await engine.getStats());
  } catch (error) {
    setError(formatError(error));
  }
}

function renderStats(stats: Awaited<ReturnType<typeof engine.getStats>>, latencyMs?: number): void {
  const timing = stats.assets.latestLoadTimings;
  elements.assetMetric.textContent = `${formatBytes(stats.assets.fetchedEncodedBytes)} encoded · ${formatBytes(stats.assets.retainedDecodedBytes)} retained`;
  elements.loadMetric.textContent =
    timing === null
      ? "waiting"
      : `${(latencyMs ?? timing.totalMs).toFixed(1)} ms promise · ${timing.decodeMs.toFixed(1)} ms decode · ${timing.uploadMs.toFixed(1)} ms upload`;
  elements.renderMetric.textContent = `${stats.render.visibilityBackend.toUpperCase()} visibility · ${stats.render.visibleObjects}/${stats.render.extractedObjects} visible · ${stats.render.indirectDrawCalls} indirect draws`;
  elements.transportMetric.textContent = `${stats.transport.kind} · ${stats.transport.dirtyRanges} dirty ranges · ${formatBytes(stats.transport.bytesUploaded)} WASM staging`;
}

elements.lifecycle.addEventListener("click", () => {
  if (running) {
    engine.stop();
    elements.lifecycle.textContent = "Resume";
  } else {
    engine.start();
    elements.lifecycle.textContent = "Pause";
  }
  running = !running;
});

elements.recycle.addEventListener("click", () => {
  const previous = cubes.shift();
  if (previous === undefined) return;
  engine.destroy(previous);
  const replacement = engine.create.mesh({
    geometry: "cube",
    material: background,
    position: [0, -2.6, -8],
    scale: [0.16, 0.16, 0.16],
    bounds: { radius: 0.28 },
  });
  cubes.push(replacement);
  elements.recycle.textContent = `Recycled ${replacement.id.index}:${replacement.id.generation}`;
});

elements.cameraX.addEventListener("input", () => {
  engine.camera.position.set(Number(elements.cameraX.value), 0, 6);
});

elements.cameraFov.addEventListener("input", () => {
  engine.camera.setPerspective({
    verticalFov: (Number(elements.cameraFov.value) * Math.PI) / 180,
  });
});

window.addEventListener(
  "pagehide",
  () => {
    cancelAnimationFrame(animationFrame);
    clearInterval(statsTimer);
    engine.dispose();
  },
  { once: true },
);

function requireElements() {
  const canvas = document.querySelector<HTMLCanvasElement>("#viewport");
  const status = document.querySelector<HTMLElement>("#status");
  const assetMetric = document.querySelector<HTMLElement>("#asset-metric");
  const loadMetric = document.querySelector<HTMLElement>("#load-metric");
  const renderMetric = document.querySelector<HTMLElement>("#render-metric");
  const transportMetric = document.querySelector<HTMLElement>("#transport-metric");
  const lifecycle = document.querySelector<HTMLButtonElement>("#lifecycle");
  const recycle = document.querySelector<HTMLButtonElement>("#recycle");
  const cameraX = document.querySelector<HTMLInputElement>("#camera-x");
  const cameraFov = document.querySelector<HTMLInputElement>("#camera-fov");
  if (
    canvas === null ||
    status === null ||
    assetMetric === null ||
    loadMetric === null ||
    renderMetric === null ||
    transportMetric === null ||
    lifecycle === null ||
    recycle === null ||
    cameraX === null ||
    cameraFov === null
  ) {
    throw new Error("Showcase markup is incomplete.");
  }
  return {
    canvas,
    status,
    assetMetric,
    loadMetric,
    renderMetric,
    transportMetric,
    lifecycle,
    recycle,
    cameraX,
    cameraFov,
  };
}

function formatBytes(bytes: number): string {
  return bytes >= MEBIBYTE
    ? `${(bytes / MEBIBYTE).toFixed(2)} MiB`
    : `${(bytes / 1_024).toFixed(1)} KiB`;
}

function formatError(error: unknown): string {
  if (error instanceof GeometryLoadError)
    return `${error.code} at ${error.stage}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

function setError(message: string): void {
  elements.status.textContent = message;
  elements.status.dataset.state = "error";
}
