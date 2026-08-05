import "../../cube/src/style.css";

import { createEngine, type MeshHandle } from "@lume/api";

const canvas = document.querySelector<HTMLCanvasElement>("#viewport");
const status = document.querySelector<HTMLElement>("#status");
const replace = document.querySelector<HTMLButtonElement>("#replace");
const stats = document.querySelector<HTMLOutputElement>("#stats");
if (canvas === null || status === null || replace === null || stats === null) {
  throw new Error("Example markup is incomplete.");
}
const statusNode = status;

const engine = createEngine({
  canvas,
  wasmUrl: "/lume_core.wasm",
  entityCapacity: 8,
  clearColor: { r: 0.018, g: 0.012, b: 0.03, a: 1 },
});
const blue = engine.create.basicMaterial({ color: [0.35, 0.55, 1, 1] });
let mesh: MeshHandle | undefined;

function replaceCube(): void {
  if (mesh !== undefined) engine.destroy(mesh);
  mesh = engine.create.mesh({ geometry: "cube", material: blue, position: [0, 0, -3] });
  statusNode.textContent = `Live entity: index ${mesh.id.index}, generation ${mesh.id.generation}`;
}

replaceCube();
engine.create.perspectiveCamera({ position: [0, 0, 3], far: 100 });
replace.addEventListener("click", replaceCube);

try {
  await engine.init();
  engine.start();
  const current = await engine.getStats();
  stats.textContent = `${current.render.visibleObjects} visible objects · click to recycle the mesh handle`;
} catch (error) {
  statusNode.textContent = error instanceof Error ? error.message : String(error);
  statusNode.dataset.state = "error";
}

addEventListener("pagehide", () => engine.dispose(), { once: true });
