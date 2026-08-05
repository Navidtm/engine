import "../../cube/src/style.css";

import { createEngine } from "@lume/api";

const canvas = document.querySelector<HTMLCanvasElement>("#viewport");
const x = document.querySelector<HTMLInputElement>("#x");
const yaw = document.querySelector<HTMLInputElement>("#yaw");
const fov = document.querySelector<HTMLInputElement>("#fov");
const status = document.querySelector<HTMLOutputElement>("#status");
if (canvas === null || x === null || yaw === null || fov === null || status === null) {
  throw new Error("Example markup is incomplete.");
}
const xControl = x;
const yawControl = yaw;
const fovControl = fov;
const statusOutput = status;

const engine = createEngine({
  canvas,
  wasmUrl: "/lume_core.wasm",
  camera: { position: [0, 0, 5], verticalFov: Math.PI / 3, near: 0.1, far: 100 },
  clearColor: { r: 0.012, g: 0.018, b: 0.035, a: 1 },
});

const material = engine.create.basicMaterial({ color: [0.24, 0.7, 1, 1] });
for (const position of [
  [-2, 0, -4],
  [0, 0, -6],
  [2, 0, -8],
] as const) {
  engine.create.mesh({ geometry: "cube", material, position });
}

function updateCamera(): void {
  const cameraX = Number(xControl.value);
  const yawRadians = (Number(yawControl.value) * Math.PI) / 180;
  engine.camera.position.set(cameraX, 0, 5);
  engine.camera.rotation.set(0, Math.sin(yawRadians * 0.5), 0, Math.cos(yawRadians * 0.5));
  engine.camera.setPerspective({ verticalFov: (Number(fovControl.value) * Math.PI) / 180 });
  statusOutput.textContent = `x ${cameraX.toFixed(1)} · yaw ${yawControl.value}° · fov ${fovControl.value}°`;
}

xControl.addEventListener("input", updateCamera);
yawControl.addEventListener("input", updateCamera);
fovControl.addEventListener("input", updateCamera);

try {
  await engine.init();
  engine.start();
  updateCamera();
} catch (error) {
  statusOutput.textContent = error instanceof Error ? error.message : String(error);
}

addEventListener("pagehide", () => engine.dispose(), { once: true });
