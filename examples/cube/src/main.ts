import {
  boxGeometry,
  camera,
  createEngine,
  material,
  mesh,
  transform,
} from "@lume/api";
import "./style.css";

const canvas = document.querySelector<HTMLCanvasElement>("#viewport");
const status = document.querySelector<HTMLElement>("#status");
const statsOutput = document.querySelector<HTMLOutputElement>("#stats");
if (canvas === null || status === null || statsOutput === null) {
  throw new Error("Example markup is incomplete.");
}

const engine = createEngine({
  canvas,
  wasmUrl: "/lume_core.wasm",
  powerPreference: "high-performance",
  entityCapacity: 4_096,
  clearColor: { r: 0.012, g: 0.017, b: 0.032, a: 1 },
  onError(error) {
    status.textContent = error.message;
    status.dataset.state = "error";
  },
});

const materialEntity = engine.world.createEntity();
engine.world.add(materialEntity, material({ color: [0.32, 0.58, 1, 1] }));

const cube = engine.world.createEntity();
engine.world.add(cube, transform({ rotation: [0.18, 0.32, 0, 0.93] }));
engine.world.add(cube, mesh(boxGeometry(), materialEntity));

const mainCamera = engine.world.createEntity();
engine.world.add(mainCamera, transform({ position: [0, 0, 3] }));
engine.world.add(mainCamera, camera({ near: 0.1, far: 100 }));

try {
  await engine.init();
  engine.start();
  status.textContent = "Indexed cube · extracted RenderWorld · Rust/WASM";
  status.dataset.state = "ready";
  const stats = await engine.getStats();
  statsOutput.textContent = `${stats.renderInstances} instance · ${stats.drawCalls} draw · ${Math.round(stats.gpuBufferBytes / 1024)} KiB GPU · ${Math.round(stats.wasmHeapBytes / 1024)} KiB WASM`;
} catch (error) {
  status.textContent = error instanceof Error ? error.message : String(error);
  status.dataset.state = "error";
}

window.addEventListener("pagehide", () => engine.dispose(), { once: true });
