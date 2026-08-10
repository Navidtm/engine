import "./style.css";

import { createEngine } from "@lume/api";

const canvas = document.querySelector<HTMLCanvasElement>("#viewport");
const status = document.querySelector<HTMLElement>("#status");
if (canvas === null || status === null) throw new Error("Example markup is incomplete.");

const engine = createEngine({
  canvas,
  powerPreference: "high",
  camera: { position: [0, 0, 3] },
  clearColor: { r: 0.015, g: 0.02, b: 0.035, a: 1 },
  onError(error) {
    status.textContent = error.message;
    status.dataset.state = "error";
  },
});

const violet = engine.create.basicMaterial({ color: [0.5, 0.3, 1, 1] });
engine.create.mesh({ geometry: "triangle", material: violet, position: [0, 0, -2] });

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
