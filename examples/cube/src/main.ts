import "./style.css";

import { createEngine } from "@lume/api";

const canvas = document.querySelector<HTMLCanvasElement>("#viewport");
const status = document.querySelector<HTMLElement>("#status");
const statsOutput = document.querySelector<HTMLOutputElement>("#stats");
if (canvas === null || status === null || statsOutput === null) {
  throw new Error("Example markup is incomplete.");
}

const engine = createEngine({
  canvas,
  powerPreference: "high",
  entityCapacity: 4_096,
  camera: { position: [0, 0, 3], near: 0.1, far: 100 },
  clearColor: { r: 0.012, g: 0.017, b: 0.032, a: 1 },
  onError(error) {
    status.textContent = error.message;
    status.dataset.state = "error";
  },
});

const blue = engine.create.basicMaterial({ color: [0.32, 0.58, 1, 1] });
const cube = engine.create.mesh({
  geometry: "cube",
  material: blue,
  rotation: [0.18, 0.32, 0, 0.93],
});
cube.position.set(0, 0, -2);

try {
  await engine.init();
  engine.start();
  status.textContent = "Indexed cube · extracted RenderWorld · Rust/WASM";
  status.dataset.state = "ready";
  const stats = await engine.getStats();
  statsOutput.textContent = `${stats.render.visibleObjects} visible · ${stats.render.drawCalls} draw · ${Math.round(stats.memory.gpuBuffers / 1024)} KiB GPU · ${Math.round(stats.memory.wasmHeap / 1024)} KiB WASM`;
} catch (error) {
  status.textContent = error instanceof Error ? error.message : String(error);
  status.dataset.state = "error";
}

window.addEventListener("pagehide", () => engine.dispose(), { once: true });
