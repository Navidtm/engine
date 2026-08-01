/// <reference lib="webworker" />

import type { MainToWorkerMessage, WorkerToMainMessage } from "./protocol.js";
import { createWorkerRuntime } from "./worker-runtime.js";

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;
const receive = createWorkerRuntime({
  postMessage(message: WorkerToMainMessage) {
    scope.postMessage(message);
  },
  requestAnimationFrame(callback: FrameRequestCallback) {
    return scope.requestAnimationFrame(callback);
  },
  cancelAnimationFrame(handle: number) {
    scope.cancelAnimationFrame(handle);
  },
});

scope.addEventListener("message", (event: MessageEvent<MainToWorkerMessage>) => {
  receive(event.data);
});
