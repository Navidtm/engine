import "../../cube/src/style.css";

import { createEngine } from "@lume/api";

const canvas = document.querySelector<HTMLCanvasElement>("#viewport");
const output = document.querySelector<HTMLOutputElement>("#stats");
if (canvas === null || output === null) throw new Error("Example markup is incomplete.");
const engine = createEngine({
  canvas,
  wasmUrl: "/lume_core.wasm",
  entityCapacity: 1_024,
  clearColor: { r: 0.01, g: 0.015, b: 0.03, a: 1 },
});
const material = engine.create.basicMaterial({ color: [0.2, 0.72, 1, 1] });
for (let index = 0; index < 256; index += 1) {
  engine.create.mesh({
    geometry: "cube",
    material,
    position: [(index % 16) - 7.5, Math.floor(index / 16) - 7.5, -18],
  });
}
engine.create.perspectiveCamera({ position: [0, 0, 5], far: 100 });
await engine.init();
engine.start();
const stats = await engine.getStats();
output.textContent = `${stats.render.visibleObjects} instances · ${stats.render.drawCalls} draw calls`;
addEventListener("pagehide", () => engine.dispose(), { once: true });
