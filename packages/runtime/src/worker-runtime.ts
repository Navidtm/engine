import { createMeshRenderer, type MeshRenderer, type SurfaceSize } from "@lume/renderer";

import {
  beginFrameSample,
  completeFrameSample,
  createFrameInstrumentation,
  type FrameInstrumentation,
  FrameStage,
  recordFrameStage,
  requestFrameSample,
} from "./frame-instrumentation.js";
import {
  type EngineStats,
  type MainToWorkerMessage,
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeCommand,
  type WorkerToMainMessage,
} from "./protocol.js";
import { createResourceCoordinator, type ResourceCoordinator } from "./resource-coordinator.js";
import { SharedHeader } from "./shared-memory/layout.js";
import { openSharedRuntimeViews, type SharedRuntimeViews } from "./shared-memory/views.js";
import { createWasmCore, type WasmCore } from "./wasm.js";

interface WorkerRuntimeState {
  renderer: MeshRenderer | undefined;
  core: WasmCore | undefined;
  coordinator: ResourceCoordinator | undefined;
  size: SurfaceSize | undefined;
  frameRequest: number | undefined;
  running: boolean;
  lifecycleEpoch: number;
  schedulerEpoch: number;
  disposed: boolean;
  initializing: boolean;
  recovering: boolean;
  recoveryRunningIntent: boolean;
  readonly deferredRecoveryMessages: Array<
    Extract<MainToWorkerMessage, { type: "command" | "batch" }>
  >;
  lastFrameTimeMs: number;
  lastCpuTimeMs: number;
  previousFrameStart: number;
  sharedMemory: SharedRuntimeViews | undefined;
  messages: number;
  readonly instrumentation: FrameInstrumentation;
}

/** Small worker-global abstraction used by the runtime and deterministic tests. */
export interface WorkerHost {
  /** Sends a lifecycle, error, or stats event back to the main thread. */
  postMessage(message: WorkerToMainMessage): void;
  /** Schedules the next worker render frame. */
  requestAnimationFrame(callback: FrameRequestCallback): number;
  /** Cancels a previously scheduled worker frame. */
  cancelAnimationFrame(handle: number): void;
}

/** Creates a stateful worker message handler with transactional initialization. */
export function createWorkerRuntime(host: WorkerHost): (message: MainToWorkerMessage) => void {
  const state: WorkerRuntimeState = {
    renderer: undefined,
    core: undefined,
    coordinator: undefined,
    size: undefined,
    frameRequest: undefined,
    running: false,
    lifecycleEpoch: 0,
    schedulerEpoch: 0,
    disposed: false,
    initializing: false,
    recovering: false,
    recoveryRunningIntent: false,
    deferredRecoveryMessages: [],
    lastFrameTimeMs: 0,
    lastCpuTimeMs: 0,
    previousFrameStart: 0,
    sharedMemory: undefined,
    messages: 0,
    instrumentation: createFrameInstrumentation(),
  };

  const report = (error: unknown): void => {
    const value = error instanceof Error ? error : new Error(String(error));
    const event: WorkerToMainMessage =
      value.stack === undefined
        ? { type: "error", message: value.message }
        : { type: "error", message: value.message, stack: value.stack };
    host.postMessage(event);
  };

  const invalidateScheduler = (): number => {
    state.schedulerEpoch += 1;
    state.previousFrameStart = 0;
    if (state.frameRequest !== undefined) host.cancelAnimationFrame(state.frameRequest);
    state.frameRequest = undefined;
    return state.schedulerEpoch;
  };

  const stopScheduling = (): void => {
    state.running = false;
    invalidateScheduler();
  };

  const frame = (schedulerEpoch: number, scheduleNext: FrameRequestCallback): void => {
    if (schedulerEpoch !== state.schedulerEpoch || !state.running || state.disposed) {
      return;
    }
    state.frameRequest = undefined;
    try {
      const frameStart = performance.now();
      const profileStages = beginFrameSample(state.instrumentation);
      const transportStart = profileStages ? performance.now() : 0;
      updateSharedCommands();
      state.core?.updateSharedTransforms();
      if (profileStages) {
        recordFrameStage(
          state.instrumentation,
          FrameStage.TransportApply,
          performance.now() - transportStart,
        );
      }
      const renderFrame = state.core?.update(profileStages);
      if (renderFrame !== undefined) state.renderer?.execute(renderFrame, profileStages);
      if (profileStages && state.core !== undefined && state.renderer !== undefined) {
        const coreTimings = state.core.frameTimings;
        const rendererTimings = state.renderer.frameTimings;
        recordFrameStage(state.instrumentation, FrameStage.Systems, coreTimings.systemsCpuTimeMs);
        recordFrameStage(
          state.instrumentation,
          FrameStage.Extraction,
          coreTimings.extractionCpuTimeMs,
        );
        recordFrameStage(
          state.instrumentation,
          FrameStage.Visibility,
          coreTimings.visibilityCpuTimeMs,
        );
        recordFrameStage(
          state.instrumentation,
          FrameStage.BufferUpload,
          rendererTimings.bufferUploadCpuTimeMs,
        );
        recordFrameStage(
          state.instrumentation,
          FrameStage.RenderPreparation,
          rendererTimings.renderPreparationCpuTimeMs,
        );
        recordFrameStage(
          state.instrumentation,
          FrameStage.CommandEncoding,
          rendererTimings.commandEncodingCpuTimeMs,
        );
        recordFrameStage(
          state.instrumentation,
          FrameStage.QueueSubmit,
          rendererTimings.queueSubmitCpuTimeMs,
        );
        completeFrameSample(state.instrumentation);
      }
      const frameEnd = performance.now();
      state.lastCpuTimeMs = frameEnd - frameStart;
      state.lastFrameTimeMs =
        state.previousFrameStart === 0 ? 0 : frameStart - state.previousFrameStart;
      state.previousFrameStart = frameStart;
      state.frameRequest = host.requestAnimationFrame(scheduleNext);
    } catch (error) {
      stopScheduling();
      report(error);
    }
  };

  const apply = (command: RuntimeCommand): void => {
    const core = state.core;
    const coordinator = state.coordinator;
    const renderer = state.renderer;
    const size = state.size;
    if (
      core === undefined ||
      coordinator === undefined ||
      renderer === undefined ||
      size === undefined
    ) {
      throw new Error("Runtime is not initialized.");
    }
    coordinator.apply(command, core, renderer, size.width / Math.max(size.height, 1));
  };

  const applySharedCommand = (command: RuntimeCommand): void => apply(command);

  const updateSharedCommands = (): void => {
    state.core?.updateSharedCommands(applySharedCommand);
  };

  const assertLifecycleReady = (): void => {
    if (
      state.core === undefined ||
      state.coordinator === undefined ||
      (state.renderer === undefined && !state.recovering)
    ) {
      throw new Error("Runtime is not initialized.");
    }
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
          message.value.resourceCapacity,
        ),
        createWasmCore(
          message.value.wasmUrl,
          message.value.entityCapacity,
          message.value.transformCapacity,
          message.value.sharedMemory,
          message.value.resourceCapacity,
          message.value.meshRendererCapacity,
          message.value.cameraCapacity,
          message.value.boundsCapacity,
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
      state.coordinator = createResourceCoordinator(
        message.value.resourceCapacity,
        message.value.entityCapacity,
      );
      const latestSize = state.size;
      if (latestSize !== undefined && latestSize !== message.value.size) {
        core.resize(latestSize.width / Math.max(latestSize.height, 1));
        renderer.resize(latestSize);
      }
      watchDeviceLoss(message, renderer);
      host.postMessage({ type: "ready" });
    } catch (error) {
      if (state.disposed) return;
      renderer?.dispose();
      core?.dispose();
      report(error);
    }
  };

  const watchDeviceLoss = (
    message: Extract<MainToWorkerMessage, { type: "init" }>,
    renderer: MeshRenderer,
  ): void => {
    void renderer.lost.then((info) => {
      if (state.disposed || state.renderer !== renderer || state.recovering) return;
      void recoverRenderer(message, renderer).catch((error: unknown) => {
        if (state.disposed) return;
        const recoveryMessage = error instanceof Error ? error.message : String(error);
        host.postMessage({
          type: "device-lost",
          reason: info.reason,
          message: `${info.message} Recovery failed: ${recoveryMessage}`,
        });
      });
    });
  };

  const recoverRenderer = async (
    message: Extract<MainToWorkerMessage, { type: "init" }>,
    lostRenderer: MeshRenderer,
  ): Promise<void> => {
    state.recoveryRunningIntent = state.running;
    state.recovering = true;
    stopScheduling();
    state.renderer = undefined;
    lostRenderer.dispose();
    let replacement: MeshRenderer | undefined;
    try {
      replacement = await createMeshRenderer(
        message.value.canvas,
        state.size ?? message.value.size,
        message.value.entityCapacity,
        message.value.renderer,
        message.value.resourceCapacity,
      );
      if (state.disposed) {
        replacement.dispose();
        return;
      }
      const coordinator = state.coordinator;
      const core = state.core;
      if (coordinator === undefined || core === undefined) {
        throw new Error("Runtime state disappeared during device recovery.");
      }
      coordinator.rebuildRenderer(replacement);
      core.invalidateRendererCache();
      state.renderer = replacement;
      watchDeviceLoss(message, replacement);
      for (const deferred of state.deferredRecoveryMessages) {
        if (deferred.type === "command") {
          updateSharedCommands();
          core.updateSharedTransforms();
          apply(deferred.value);
        } else {
          if (deferred.ordered === true) {
            updateSharedCommands();
            core.updateSharedTransforms();
          }
          for (const command of deferred.value) apply(command);
        }
      }
      state.deferredRecoveryMessages.length = 0;
      if (state.recoveryRunningIntent) {
        const schedulerEpoch = invalidateScheduler();
        const scheduleNext: FrameRequestCallback = () => frame(schedulerEpoch, scheduleNext);
        state.running = true;
        frame(schedulerEpoch, scheduleNext);
      }
    } catch (error) {
      replacement?.dispose();
      throw error;
    } finally {
      state.recovering = false;
      state.recoveryRunningIntent = false;
    }
  };

  return (message): void => {
    if (state.disposed) return;
    state.messages += 1;
    if (state.recovering && (message.type === "command" || message.type === "batch")) {
      state.deferredRecoveryMessages.push(message);
      return;
    }
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
          updateSharedCommands();
          state.core?.updateSharedTransforms();
          apply(message.value);
          break;
        case "batch":
          if (message.ordered === true) {
            updateSharedCommands();
            state.core?.updateSharedTransforms();
          }
          for (const command of message.value) apply(command);
          break;
        case "start": {
          assertLifecycleReady();
          if (message.lifecycleEpoch <= state.lifecycleEpoch) break;
          state.lifecycleEpoch = message.lifecycleEpoch;
          if (state.recovering) {
            state.recoveryRunningIntent = true;
            break;
          }
          const schedulerEpoch = invalidateScheduler();
          const scheduleNext: FrameRequestCallback = () => frame(schedulerEpoch, scheduleNext);
          state.running = true;
          frame(schedulerEpoch, scheduleNext);
          break;
        }
        case "stop":
          assertLifecycleReady();
          if (message.lifecycleEpoch <= state.lifecycleEpoch) break;
          state.lifecycleEpoch = message.lifecycleEpoch;
          if (state.recovering) state.recoveryRunningIntent = false;
          stopScheduling();
          host.postMessage({ type: "stopped", lifecycleEpoch: message.lifecycleEpoch });
          break;
        case "resize":
          state.size = message.value;
          state.core?.resize(message.value.width / Math.max(message.value.height, 1));
          state.renderer?.resize(message.value);
          break;
        case "get-stats": {
          updateSharedCommands();
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
                computeDispatches: rendererStats?.computeDispatches ?? 0,
                indirectDrawCalls: rendererStats?.indirectDrawCalls ?? 0,
                visibilityBackend: rendererStats?.visibilityBackend ?? "cpu",
                gpuVisibleObjects: rendererStats?.gpuVisibleObjects ?? null,
                gpuVisibilityHash: rendererStats?.gpuVisibilityHash ?? null,
                cpuVisibilityHash: rendererStats?.cpuVisibilityHash ?? null,
                visibleObjects: rendererStats?.cpuVisibleObjects ?? coreStats?.visibleObjects ?? 0,
                extractedObjects: coreStats?.renderInstances ?? 0,
              },
              memory: {
                gpuBuffers: rendererStats?.gpuBufferBytes ?? 0,
                wasmHeap: coreStats?.wasmHeapBytes ?? 0,
                jsHeap: workerHeapBytes(),
              },
              timings: {
                bufferUploadCpuTime: rendererStats?.bufferUploadCpuTimeMs ?? 0,
                bufferUploadBytes: rendererStats?.bufferUploadBytes ?? 0,
                bufferWriteCount: rendererStats?.bufferWriteCount ?? 0,
                uploadBytesByDomain: rendererStats?.uploadBytesByDomain ?? {
                  instances: 0,
                  slotState: 0,
                  bounds: 0,
                  resources: 0,
                  visibility: 0,
                  cameras: 0,
                  indirect: 0,
                },
                framePreparationCpuTime: rendererStats?.framePreparationCpuTimeMs ?? 0,
                cpuStages: {
                  sampleCount: state.instrumentation.sampleCount,
                  latest: frameStageSnapshot(state.instrumentation.latest),
                  cumulative: frameStageSnapshot(state.instrumentation.cumulative),
                },
              },
              transport: transportStats(
                state.sharedMemory,
                state.messages,
                coreStats?.dirtyRanges ?? 0,
                coreStats?.bytesUploaded ?? 0,
              ),
            },
          });
          requestFrameSample(state.instrumentation);
          break;
        }
        case "dispose":
          stopScheduling();
          state.disposed = true;
          if (state.core !== undefined && state.renderer !== undefined) {
            state.coordinator?.dispose(state.core, state.renderer);
          }
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

function frameStageSnapshot(values: Float64Array<ArrayBuffer>) {
  return {
    transportApply: values[FrameStage.TransportApply] ?? 0,
    systems: values[FrameStage.Systems] ?? 0,
    extraction: values[FrameStage.Extraction] ?? 0,
    visibility: values[FrameStage.Visibility] ?? 0,
    bufferUpload: values[FrameStage.BufferUpload] ?? 0,
    renderPreparation: values[FrameStage.RenderPreparation] ?? 0,
    commandEncoding: values[FrameStage.CommandEncoding] ?? 0,
    queueSubmit: values[FrameStage.QueueSubmit] ?? 0,
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
