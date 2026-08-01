export type {
  EngineStats,
  MainToWorkerMessage,
  RuntimeCommand,
  RuntimeInit,
  WorkerToMainMessage,
} from "./protocol.js";
export { RUNTIME_PROTOCOL_VERSION } from "./protocol.js";
export {
  allocateSharedRuntimeMemory,
  supportsSharedRuntimeMemory,
} from "./shared-memory/allocator.js";
export type { SharedTransformValue } from "./shared-memory/synchronization.js";
export { drainSharedTransforms, writeSharedTransform } from "./shared-memory/synchronization.js";
export type { SharedRuntimeViews } from "./shared-memory/views.js";
export { openSharedRuntimeViews } from "./shared-memory/views.js";

/** Creates the package-owned module worker shipped beside this module. */
export function createDefaultWorker(): Worker {
  return new Worker(new URL("./worker.js", import.meta.url), {
    type: "module",
    name: "lume-renderer",
  });
}
