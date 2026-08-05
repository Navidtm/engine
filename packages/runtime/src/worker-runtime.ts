import { createMeshRenderer, type MeshRenderer, type SurfaceSize } from "@lume/renderer";

import {
  type EngineStats,
  type MainToWorkerMessage,
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeCommand,
  type WorkerToMainMessage,
} from "./protocol.js";
import { SharedHeader } from "./shared-memory/layout.js";
import { openSharedRuntimeViews, type SharedRuntimeViews } from "./shared-memory/views.js";
import { createWasmCore, type WasmCore } from "./wasm.js";

interface WorkerRuntimeState {
  renderer: MeshRenderer | undefined;
  core: WasmCore | undefined;
  size: SurfaceSize | undefined;
  frameRequest: number | undefined;
  running: boolean;
  disposed: boolean;
  initializing: boolean;
  lastFrameTimeMs: number;
  lastCpuTimeMs: number;
  previousFrameStart: number;
  sharedMemory: SharedRuntimeViews | undefined;
  messages: number;
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
    initializing: false,
    lastFrameTimeMs: 0,
    lastCpuTimeMs: 0,
    previousFrameStart: 0,
    sharedMemory: undefined,
    messages: 0,
  };

  const report = (error: unknown): void => {
    const value = error instanceof Error ? error : new Error(String(error));
    const event: WorkerToMainMessage =
      value.stack === undefined
        ? { type: "error", message: value.message }
        : { type: "error", message: value.message, stack: value.stack };
    host.postMessage(event);
  };

  const frame = (): void => {
    if (!state.running || state.disposed) return;
    try {
      const frameStart = performance.now();
      const renderFrame = state.core?.update();
      if (renderFrame !== undefined) state.renderer?.execute(renderFrame);
      const frameEnd = performance.now();
      state.lastCpuTimeMs = frameEnd - frameStart;
      state.lastFrameTimeMs =
        state.previousFrameStart === 0 ? 0 : frameStart - state.previousFrameStart;
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

  const initialize = async (
    message: Extract<MainToWorkerMessage, { type: "init" }>,
  ): Promise<void> => {
    let renderer: MeshRenderer | undefined;
    let core: WasmCore | undefined;
    try {
      const [rendererResult, coreResult] = await Promise.allSettled([
        createMeshRenderer(
          message.value.canvas,
          message.value.size,
          message.value.entityCapacity,
          message.value.renderer,
        ),
        createWasmCore(
          message.value.wasmUrl,
          message.value.entityCapacity,
          message.value.transformCapacity,
          message.value.sharedMemory,
          message.value.size.width / Math.max(message.value.size.height, 1),
        ),
      ]);
      if (rendererResult.status === "fulfilled") renderer = rendererResult.value;
      if (coreResult.status === "fulfilled") core = coreResult.value;
      if (state.disposed) {
        renderer?.dispose();
        core?.dispose();
        return;
      }
      if (rendererResult.status === "rejected") throw rendererResult.reason;
      if (coreResult.status === "rejected") throw coreResult.reason;
      if (renderer === undefined || core === undefined)
        throw new Error("Runtime initialization failed.");
      state.renderer = renderer;
      state.core = core;
      void renderer.lost.then((info) => {
        if (state.disposed || state.renderer !== renderer) return;
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
    state.messages += 1;
    try {
      switch (message.type) {
        case "init": {
          if (message.value.protocolVersion !== RUNTIME_PROTOCOL_VERSION) {
            throw new Error("Lume worker protocol version mismatch.");
          }
          if (state.initializing || state.renderer !== undefined) {
            throw new Error("Runtime is already initializing or initialized.");
          }
          state.initializing = true;
          state.size = message.value.size;
          state.sharedMemory =
            message.value.sharedMemory === undefined
              ? undefined
              : openSharedRuntimeViews(message.value.sharedMemory);
          void initialize(message).finally(() => {
            state.initializing = false;
          });
          break;
        }
        case "command":
          state.core?.updateSharedCommands();
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
          state.core?.updateSharedCommands();
          const coreStats = state.core?.stats();
          const rendererStats = state.renderer?.stats();
          host.postMessage({
            type: "stats",
            requestId: message.requestId,
            value: {
              frameTime: state.lastFrameTimeMs,
              cpuTime: state.lastCpuTimeMs,
              gpuTime: rendererStats?.gpuTimeMs ?? null,
              allocationsPerFrame: rendererStats?.browserObjectsPerFrame ?? 0,
              render: {
                drawCalls: rendererStats?.drawCalls ?? 0,
                visibleObjects: coreStats?.visibleObjects ?? 0,
                extractedObjects: coreStats?.renderInstances ?? 0,
              },
              memory: {
                gpuBuffers: rendererStats?.gpuBufferBytes ?? 0,
                wasmHeap: coreStats?.wasmHeapBytes ?? 0,
                jsHeap: workerHeapBytes(),
              },
              timings: {
                bufferUploadCpuTime: rendererStats?.bufferUploadCpuTimeMs ?? 0,
                framePreparationCpuTime: rendererStats?.framePreparationCpuTimeMs ?? 0,
              },
              transport: transportStats(
                state.sharedMemory,
                state.messages,
                coreStats?.dirtyRanges ?? 0,
                coreStats?.bytesUploaded ?? 0,
              ),
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

function transportStats(
  sharedMemory: SharedRuntimeViews | undefined,
  messages: number,
  dirtyRanges: number,
  bytesUploaded: number,
): EngineStats["transport"] {
  if (sharedMemory === undefined) {
    return {
      kind: "commands",
      messages,
      sharedWrites: 0,
      dirtyRanges: 0,
      bytesUploaded: 0,
      queueDepth: 0,
      droppedCommands: 0,
    };
  }
  return {
    kind: "shared-memory",
    messages,
    sharedWrites: Atomics.load(sharedMemory.header, SharedHeader.SharedWrites),
    dirtyRanges,
    bytesUploaded,
    queueDepth:
      Atomics.load(sharedMemory.header, SharedHeader.PendingCount) +
      Atomics.load(sharedMemory.header, SharedHeader.CommandPending),
    droppedCommands: Atomics.load(sharedMemory.header, SharedHeader.DroppedCommands),
  };
}

function workerHeapBytes(): number | null {
  const measured = performance as Performance & {
    readonly memory?: { readonly usedJSHeapSize: number };
  };
  return measured.memory?.usedJSHeapSize ?? null;
}
