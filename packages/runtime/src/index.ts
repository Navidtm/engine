export { RUNTIME_PROTOCOL_VERSION } from "./protocol.js";
export type {
  EngineStats,
  MainToWorkerMessage,
  RuntimeCommand,
  RuntimeInit,
  WorkerToMainMessage,
} from "./protocol.js";

/** Creates the package-owned module worker shipped beside this module. */
export function createDefaultWorker(): Worker {
  return new Worker(new URL("./worker.js", import.meta.url), {
    type: "module",
    name: "lume-renderer",
  });
}
