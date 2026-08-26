import "./style.css";

import { createEngine, GeometryLoadError } from "@lume/api";

// Deterministic constrained-profile GLB used only by this browser integration example.
const TRIANGLE_GLB =
  "data:model/gltf-binary;base64,Z2xURgIAAACoAgAAPAIAAEpTT057ImFzc2V0Ijp7InZlcnNpb24iOiIyLjAifSwiYnVmZmVycyI6W3siYnl0ZUxlbmd0aCI6Nzh9XSwiYnVmZmVyVmlld3MiOlt7ImJ1ZmZlciI6MCwiYnl0ZU9mZnNldCI6MCwiYnl0ZUxlbmd0aCI6MzYsInRhcmdldCI6MzQ5NjJ9LHsiYnVmZmVyIjowLCJieXRlT2Zmc2V0IjozNiwiYnl0ZUxlbmd0aCI6MzYsInRhcmdldCI6MzQ5NjJ9LHsiYnVmZmVyIjowLCJieXRlT2Zmc2V0Ijo3MiwiYnl0ZUxlbmd0aCI6NiwidGFyZ2V0IjozNDk2M31dLCJhY2Nlc3NvcnMiOlt7ImJ1ZmZlclZpZXciOjAsImNvbXBvbmVudFR5cGUiOjUxMjYsImNvdW50IjozLCJ0eXBlIjoiVkVDMyIsIm1pbiI6WzAsMCwwXSwibWF4IjpbMSwxLDBdfSx7ImJ1ZmZlclZpZXciOjEsImNvbXBvbmVudFR5cGUiOjUxMjYsImNvdW50IjozLCJ0eXBlIjoiVkVDMyJ9LHsiYnVmZmVyVmlldyI6MiwiY29tcG9uZW50VHlwZSI6NTEyMywiY291bnQiOjMsInR5cGUiOiJTQ0FMQVIifV0sIm1lc2hlcyI6W3sicHJpbWl0aXZlcyI6W3siYXR0cmlidXRlcyI6eyJQT1NJVElPTiI6MCwiTk9STUFMIjoxfSwiaW5kaWNlcyI6MiwibW9kZSI6NH1dfV19IFAAAABCSU4AAAAAAAAAAAAAAAAAAACAPwAAAAAAAAAAAAAAAAAAgD8AAAAAAAAAAAAAAAAAAIA/AAAAAAAAAAAAAIA/AAAAAAAAAAAAAIA/AAABAAIAAAA=";

interface GeometryExampleResult {
  readonly status: "ready" | "error";
  readonly successfulLoads: number;
  readonly retainedDecodedBytes: number;
  readonly message: string;
}

declare global {
  interface Window {
    __LUME_GEOMETRY_EXAMPLE_RESULT__: Promise<GeometryExampleResult>;
  }
}

const canvas = document.querySelector<HTMLCanvasElement>("#viewport");
const status = document.querySelector<HTMLElement>("#status");
const statsOutput = document.querySelector<HTMLOutputElement>("#stats");
if (canvas === null || status === null || statsOutput === null) {
  throw new Error("Example markup is incomplete.");
}
const statusElement = status;
const statsElement = statsOutput;

const engine = createEngine({
  canvas,
  resourceCapacity: 8,
  geometryLimits: {
    decode: {
      maxEncodedBytes: 1_024,
      maxDecodedBytes: 1_024,
      maxVertices: 64,
      maxIndices: 192,
    },
    maxTemporaryBytes: 4_096,
    maxRetainedDecodedBytes: 2_048,
    maxResidentGpuBytes: 4_096,
  },
  camera: { position: [0, 0, 3], near: 0.1, far: 100 },
  clearColor: { r: 0.012, g: 0.026, b: 0.055, a: 1 },
  onError(error) {
    statusElement.textContent = error.message;
    statusElement.dataset.state = "error";
  },
});

window.__LUME_GEOMETRY_EXAMPLE_RESULT__ = run();

async function run(): Promise<GeometryExampleResult> {
  try {
    await engine.init();
    const geometry = await engine.load.geometry(TRIANGLE_GLB);
    const material = engine.create.basicMaterial({ color: [0.25, 0.7, 1, 1] });
    engine.create.mesh({ geometry, material, position: [-0.5, -0.5, -2] });
    engine.start();
    const stats = await engine.getStats();
    const message = `${stats.assets.successfulLoads} worker load · ${stats.assets.retainedDecodedBytes} retained bytes`;
    statusElement.textContent = "GLB decoded in Worker and published atomically";
    statusElement.dataset.state = "ready";
    statsElement.textContent = message;
    return {
      status: "ready",
      successfulLoads: stats.assets.successfulLoads,
      retainedDecodedBytes: stats.assets.retainedDecodedBytes,
      message,
    };
  } catch (error) {
    const message =
      error instanceof GeometryLoadError
        ? `${error.code} at ${error.stage}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    statusElement.textContent = message;
    statusElement.dataset.state = "error";
    return { status: "error", successfulLoads: 0, retainedDecodedBytes: 0, message };
  }
}

window.addEventListener("pagehide", () => engine.dispose(), { once: true });
