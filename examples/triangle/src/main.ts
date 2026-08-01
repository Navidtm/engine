import {
  camera,
  createEngine,
  material,
  mesh,
  transform,
  triangleGeometry,
} from "@lume/api";
import "./style.css";

const canvas = document.querySelector<HTMLCanvasElement>("#viewport");
const status = document.querySelector<HTMLElement>("#status");
if (canvas === null || status === null) throw new Error("Example markup is incomplete.");

const engine = createEngine({
  canvas,
  wasmUrl: "/lume_core.wasm",
  powerPreference: "high-performance",
  clearColor: { r: 0.015, g: 0.02, b: 0.035, a: 1 },
  onError(error) {
    status.textContent = error.message;
    status.dataset.state = "error";
  },
});

const world = engine.world;
const materialEntity = world.createEntity();
world.add(materialEntity, material({ color: [0.5, 0.3, 1, 1] }));

const triangle = world.createEntity();
world.add(triangle, transform({ position: [0, 0, -2] }));
world.add(triangle, mesh(triangleGeometry(), materialEntity));

const mainCamera = world.createEntity();
world.add(mainCamera, transform({ position: [0, 0, 3] }));
world.add(mainCamera, camera());

try {
  await engine.init();
  engine.start();
  status.textContent = "WebGPU · worker · Rust/WASM";
  status.dataset.state = "ready";
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  status.textContent = message;
  status.dataset.state = "error";
}

window.addEventListener("pagehide", () => engine.dispose(), { once: true });
