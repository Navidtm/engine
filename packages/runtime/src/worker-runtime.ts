import { createMeshRenderer, type MeshRenderer, type SurfaceSize } from "@lume/renderer";
import {
  RUNTIME_PROTOCOL_VERSION,
  type MainToWorkerMessage,
  type RuntimeCommand,
  type WorkerToMainMessage,
} from "./protocol.js";
import { createWasmCore, type WasmCore } from "./wasm.js";

interface WorkerRuntimeState {
  renderer: MeshRenderer | undefined;
  core: WasmCore | undefined;
  size: SurfaceSize | undefined;
  frameRequest: number | undefined;
  running: boolean;
  disposed: boolean;
  lastFrameTimeMs: number;
  lastCpuTimeMs: number;
  previousFrameStart: number;
}

export interface WorkerHost {
  postMessage(message: WorkerToMainMessage): void;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
}

export function createWorkerRuntime(host: WorkerHost): (message: MainToWorkerMessage) => void {
  const state: WorkerRuntimeState = {
    renderer: undefined,
    core: undefined,
    size: undefined,
    frameRequest: undefined,
    running: false,
    disposed: false,
    lastFrameTimeMs: 0,
    lastCpuTimeMs: 0,
    previousFrameStart: 0,
  };

  const report = (error: unknown): void => {
    const value = error instanceof Error ? error : new Error(String(error));
    const event: WorkerToMainMessage = value.stack === undefined
      ? { type: "error", message: value.message }
      : { type: "error", message: value.message, stack: value.stack };
    host.postMessage(event);
  };

  const frame = (): void => {
    if (!state.running || state.disposed) return;
    try {
      const frameStart = performance.now();
      const renderFrame = state.core?.update();
      if (renderFrame !== undefined) state.renderer?.render(renderFrame);
      const frameEnd = performance.now();
      state.lastCpuTimeMs = frameEnd - frameStart;
      state.lastFrameTimeMs = state.previousFrameStart === 0 ? 0 : frameStart - state.previousFrameStart;
      state.previousFrameStart = frameStart;
      state.frameRequest = host.requestAnimationFrame(frame);
    } catch (error) {
      state.running = false;
      report(error);
    }
  };

  const apply = (command: RuntimeCommand): void => {
    const core = state.core;
    const size = state.size;
    if (core === undefined || size === undefined) throw new Error("Runtime is not initialized.");
    core.apply(command, size.width / Math.max(size.height, 1));
  };

  const initialize = async (message: Extract<MainToWorkerMessage, { type: "init" }>): Promise<void> => {
    let renderer: MeshRenderer | undefined;
    let core: WasmCore | undefined;
    try {
      await Promise.all([
        createMeshRenderer(
          message.value.canvas,
          message.value.size,
          message.value.entityCapacity,
          message.value.renderer,
        ).then((value) => {
          renderer = value;
        }),
        createWasmCore(message.value.wasmUrl, message.value.entityCapacity).then((value) => {
          core = value;
        }),
      ]);
      if (state.disposed) {
        renderer?.dispose();
        core?.dispose();
        return;
      }
      if (renderer === undefined || core === undefined) {
        throw new Error("Runtime resources did not initialize.");
      }
      state.renderer = renderer;
      state.core = core;
      void renderer.device.lost.then((info) => {
        state.running = false;
        host.postMessage({
          type: "device-lost",
          reason: info.reason,
          message: info.message,
        });
      });
      host.postMessage({ type: "ready" });
    } catch (error) {
      renderer?.dispose();
      core?.dispose();
      report(error);
    }
  };

  return (message): void => {
    if (state.disposed) return;
    try {
      switch (message.type) {
        case "init": {
          if (message.value.protocolVersion !== RUNTIME_PROTOCOL_VERSION) {
            throw new Error("Lume worker protocol version mismatch.");
          }
          if (state.renderer !== undefined) throw new Error("Runtime is already initialized.");
          state.size = message.value.size;
          void initialize(message);
          break;
        }
        case "command":
          apply(message.value);
          break;
        case "batch":
          for (const command of message.value) apply(command);
          break;
        case "start":
          if (!state.running) {
            state.running = true;
            frame();
          }
          break;
        case "stop":
          state.running = false;
          if (state.frameRequest !== undefined) host.cancelAnimationFrame(state.frameRequest);
          state.frameRequest = undefined;
          host.postMessage({ type: "stopped" });
          break;
        case "resize":
          state.size = message.value;
          state.core?.resize(message.value.width / Math.max(message.value.height, 1));
          state.renderer?.resize(message.value);
          break;
        case "get-stats": {
          const coreStats = state.core?.stats();
          const rendererStats = state.renderer?.stats();
          host.postMessage({
            type: "stats",
            requestId: message.requestId,
            value: {
              entities: coreStats?.entities ?? 0,
              renderInstances: coreStats?.renderInstances ?? 0,
              visibleObjects: coreStats?.visibleObjects ?? 0,
              frameTimeMs: state.lastFrameTimeMs,
              cpuTimeMs: state.lastCpuTimeMs,
              gpuTimeMs: null,
              allocationsPerFrame: 0,
              wasmHeapBytes: coreStats?.wasmHeapBytes ?? 0,
              jsHeapBytes: workerHeapBytes(),
              gpuBufferBytes: rendererStats?.gpuBufferBytes ?? 0,
              drawCalls: rendererStats?.drawCalls ?? 0,
              bufferUploadCpuTimeMs: rendererStats?.bufferUploadCpuTimeMs ?? 0,
              framePreparationCpuTimeMs:
                rendererStats?.framePreparationCpuTimeMs ?? 0,
            },
          });
          break;
        }
        case "dispose":
          state.running = false;
          state.disposed = true;
          if (state.frameRequest !== undefined) host.cancelAnimationFrame(state.frameRequest);
          state.renderer?.dispose();
          state.core?.dispose();
          host.postMessage({ type: "disposed" });
          break;
      }
    } catch (error) {
      report(error);
    }
  };
}

function workerHeapBytes(): number | null {
  const measured = performance as Performance & {
    readonly memory?: { readonly usedJSHeapSize: number };
  };
  return measured.memory?.usedJSHeapSize ?? null;
}
