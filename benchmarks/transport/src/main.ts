import {
  allocateSharedRuntimeMemory,
  writeSharedCommand,
  writeSharedTransform,
} from "@lume/runtime";

declare global {
  interface Window {
    __LUME_TRANSPORT_RESULT__?: unknown;
  }
}

interface WorkerResult {
  readonly id: number;
  readonly workerPreparationMs: number;
  readonly checksum: number;
}

interface CommandUpdate {
  readonly entity: number;
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly scale: readonly [number, number, number];
}

type TransportRequest =
  | { readonly type: "commands"; readonly id: number; readonly updates: CommandUpdate[] }
  | { readonly type: "shared"; readonly id: number; readonly buffer: SharedArrayBuffer };

const output = document.querySelector<HTMLPreElement>("#results");
if (output === null) throw new Error("Transport benchmark markup is incomplete.");
if (!crossOriginIsolated) {
  throw new Error("Transport benchmark requires cross-origin isolation.");
}

const worker = new Worker(new URL("./transport-worker.ts", import.meta.url), { type: "module" });
let requestId = 1;
const pending = new Map<number, (result: WorkerResult) => void>();
worker.onmessage = (event: MessageEvent<WorkerResult>): void => {
  pending.get(event.data.id)?.(event.data);
  pending.delete(event.data.id);
};

const results: unknown[] = [];
for (const entities of [10_000, 100_000, 500_000, 1_000_000]) {
  results.push(await benchmarkCommands(entities));
  results.push(await benchmarkSharedMemory(entities));
}
for (const commands of [10_000, 100_000, 500_000]) {
  results.push(await benchmarkStructuralRing(commands));
}
const report = {
  schemaVersion: 1,
  benchmark: "transport-overhead",
  environment: {
    userAgent: navigator.userAgent,
    crossOriginIsolated,
    logicalCores: navigator.hardwareConcurrency,
  },
  results,
};
window.__LUME_TRANSPORT_RESULT__ = report;
output.textContent = JSON.stringify(report, null, 2);
worker.terminate();

async function benchmarkCommands(entities: number) {
  const started = performance.now();
  const updates: CommandUpdate[] = new Array(entities);
  for (let entity = 0; entity < entities; entity += 1) {
    updates[entity] = {
      entity,
      position: [entity, 0, -5],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    };
  }
  const publishMs = performance.now() - started;
  const roundTripStart = performance.now();
  const workerResult = await send({ type: "commands", id: requestId++, updates });
  return {
    transport: "command-buffer",
    entities,
    updateMs: publishMs,
    workerCommunicationMs: performance.now() - roundTripStart,
    framePreparationMs: workerResult.workerPreparationMs,
    memoryCopies: 1,
    estimatedAllocations: entities * 4 + 1,
  };
}

async function benchmarkSharedMemory(entities: number) {
  const views = allocateSharedRuntimeMemory(entities);
  const value = {
    position: [0, 0, -5] as const,
    rotation: [0, 0, 0, 1] as const,
    scale: [1, 1, 1] as const,
  };
  const started = performance.now();
  for (let entity = 0; entity < entities; entity += 1) {
    writeSharedTransform(views, entity, value);
  }
  const publishMs = performance.now() - started;
  const roundTripStart = performance.now();
  const workerResult = await send({
    type: "shared",
    id: requestId++,
    buffer: views.buffer,
  });
  return {
    transport: "shared-memory",
    entities,
    updateMs: publishMs,
    workerCommunicationMs: performance.now() - roundTripStart,
    framePreparationMs: workerResult.workerPreparationMs,
    memoryCopies: 0,
    estimatedAllocations: 0,
  };
}

async function benchmarkStructuralRing(commands: number) {
  const views = allocateSharedRuntimeMemory(commands);
  const started = performance.now();
  for (let entity = 0; entity < commands; entity += 1) {
    if (!writeSharedCommand(views, { type: "spawn", entity })) {
      throw new Error("Structural ring overflowed during a capacity-sized benchmark.");
    }
  }
  return {
    transport: "structural-spsc-ring",
    commands,
    updateMs: performance.now() - started,
    droppedCommands: 0,
    estimatedAllocations: 0,
  };
}

function send(message: TransportRequest): Promise<WorkerResult> {
  return new Promise((resolve) => {
    pending.set(message.id, resolve);
    worker.postMessage(message);
  });
}
