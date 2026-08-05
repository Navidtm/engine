import "../../cube/src/style.css";

import { createEngine } from "@lume/api";

const canvas = document.querySelector<HTMLCanvasElement>("#viewport");
const slider = document.querySelector<HTMLInputElement>("#x");
const output = document.querySelector<HTMLOutputElement>("#stats");
if (canvas === null || slider === null || output === null)
  throw new Error("Example markup is incomplete.");
const engine = createEngine({ canvas, wasmUrl: "/lume_core.wasm" });
const cube = engine.create.mesh({ geometry: "cube", position: [0, 0, -3] });
slider.addEventListener("input", () => cube.position.set(Number(slider.value), 0, -3));
await engine.init();
engine.start();
output.textContent = "Move the cube with the slider.";
addEventListener("pagehide", () => engine.dispose(), { once: true });
