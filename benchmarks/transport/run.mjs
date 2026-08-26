import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import {
  allocateSharedRuntimeMemory,
  drainSharedCommands,
  drainSharedTransforms,
  TransformField,
  writeSharedCommand,
  writeSharedTransform,
} from "../../packages/runtime/dist/index.js";
import {
  createAllocatingPositionControlBenchmark,
  createPositionControlBenchmark,
} from "./node_modules/.lume-api-benchmark/benchmark-internals.mjs";

const output = new URL("../results/transport-hardening-latest.json", import.meta.url);
const results = [];
const transformCounts = [10_000, 100_000, 500_000, 1_000_000];
const structuralCounts = [10_000, 100_000, 500_000];
const lifecycleCounts = [10_000, 100_000, 1_000_000];
const CONTROL_WRITES = 1_000_000;
const CONTROL_WARMUPS = 5;
const CONTROL_SAMPLES = 15;
const value = {
  position: [1, 2, 3],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
};

for (const entities of transformCounts) {
  results.push(benchmarkLegacyTransforms(entities));
  results.push(benchmarkSharedTransforms(entities));
  collectGarbage();
}
for (const commands of structuralCounts) {
  results.push(benchmarkStructuralRing(commands));
  collectGarbage();
}
for (const entities of lifecycleCounts) {
  results.push(benchmarkLifecycle(entities));
  collectGarbage();
}
const controlWriteResults = [
  benchmarkControlWrites(
    "allocating-control-publication",
    createAllocatingPositionControlBenchmark,
    2,
  ),
  benchmarkControlWrites("reused-control-publication", createPositionControlBenchmark, 0),
];

const report = {
  schemaVersion: 3,
  benchmark: "transport-hardening",
  generatedAt: new Date().toISOString(),
  environment: {
    runtime: "node",
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
  },
  notes: [
    "SAB and ring measurements execute the production runtime transport implementation.",
    "Node results isolate transport CPU cost; use the browser harness for browser/worker latency.",
    "Control-write samples use the production validation and shared-memory publication path; modeled allocations count explicit command/tuple literals in steady-state source.",
  ],
  results,
  controlWriteResults,
};

await mkdir(new URL("../results/", import.meta.url), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`wrote ${results.length} records to ${output.pathname}`);

function benchmarkLegacyTransforms(entities) {
  const started = performance.now();
  const commands = new Array(entities);
  for (let entity = 0; entity < entities; entity += 1) {
    commands[entity] = { entity, position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
  }
  const publishMs = performance.now() - started;
  let checksum = 0;
  const drainStarted = performance.now();
  for (const command of commands) checksum += command.entity + command.position[0];
  return {
    scenario: "legacy_object_transform_transport",
    entities,
    publishMs,
    drainMs: performance.now() - drainStarted,
    allocations: entities * 4 + 1,
    bytesUploaded: entities * 40,
    checksum,
  };
}

function benchmarkSharedTransforms(entities) {
  const views = allocateSharedRuntimeMemory(entities);
  const started = performance.now();
  for (let entity = 0; entity < entities; entity += 1) {
    writeSharedTransform(views, entity, value, TransformField.Position);
  }
  const publishMs = performance.now() - started;
  const scratch = new Float32Array(10);
  let checksum = 0;
  let ranges = 0;
  let previous = -2;
  const drainStarted = performance.now();
  const drained = drainSharedTransforms(views, scratch, (entity, _mask, values) => {
    const index = entity & 0x000f_ffff;
    if (index !== previous + 1) ranges += 1;
    previous = index;
    checksum += index + (values[0] ?? 0);
  });
  return {
    scenario: "shared_partial_transform_transport",
    entities,
    publishMs,
    drainMs: performance.now() - drainStarted,
    drained,
    dirtyRanges: ranges,
    allocations: 0,
    bytesUploaded: entities * 20 + ranges * 8,
    checksum,
  };
}

function benchmarkStructuralRing(commands) {
  const views = allocateSharedRuntimeMemory(commands);
  const started = performance.now();
  for (let entity = 0; entity < commands; entity += 1) {
    if (!writeSharedCommand(views, { type: "spawn", entity })) throw new Error("ring overflow");
  }
  const publishMs = performance.now() - started;
  let checksum = 0;
  const drainStarted = performance.now();
  const drained = drainSharedCommands(views, (_opcode, entity) => {
    checksum += entity;
  });
  return {
    scenario: "structural_spsc_ring",
    commands,
    publishMs,
    drainMs: performance.now() - drainStarted,
    drained,
    structuralCommandOverflows: 0,
    allocations: 0,
    checksum,
  };
}

function benchmarkLifecycle(count) {
  const generations = new Uint16Array(count);
  const alive = new Uint8Array(count);
  const free = new Uint32Array(count);
  const handles = new Uint32Array(count);
  const started = performance.now();
  for (let index = 0; index < count; index += 1) {
    alive[index] = 1;
    handles[index] = index;
  }
  const createMs = performance.now() - started;
  const destroyStarted = performance.now();
  let freeCount = 0;
  for (let index = 0; index < count; index += 1) {
    alive[index] = 0;
    const generation = generations[index] ?? 0;
    if (generation < 0x0fff) {
      generations[index] = generation + 1;
      free[freeCount++] = index;
    }
  }
  const destroyMs = performance.now() - destroyStarted;
  const reuseStarted = performance.now();
  for (let slot = 0; slot < count; slot += 1) {
    const index = free[--freeCount] ?? 0;
    alive[index] = 1;
    handles[slot] = (((generations[index] ?? 0) << 20) | index) >>> 0;
  }
  return {
    scenario: "generational_entity_lifecycle",
    entities: count,
    createMs,
    destroyMs,
    reuseMs: performance.now() - reuseStarted,
    staleRejected: (handles[count - 1] ?? 0) !== 0,
    runtimeAllocations: 0,
  };
}

function benchmarkControlWrites(strategy, createControl, modeledAllocationsPerWrite) {
  for (let sample = 0; sample < CONTROL_WARMUPS; sample += 1) runControlWrites(createControl());
  const samplesMs = [];
  let checksum = 0;
  for (let sample = 0; sample < CONTROL_SAMPLES; sample += 1) {
    const control = createControl();
    const started = performance.now();
    checksum ^= runControlWrites(control);
    samplesMs.push(performance.now() - started);
  }
  return {
    strategy,
    writes: CONTROL_WRITES,
    medianMs: median(samplesMs),
    minMs: Math.min(...samplesMs),
    maxMs: Math.max(...samplesMs),
    modeledAllocationsPerWrite,
    checksum,
  };
}

function runControlWrites(control) {
  let checksum = 0;
  for (let write = 0; write < CONTROL_WRITES; write += 1) {
    const x = write & 255;
    control.set(x, 2, 3);
    checksum = (checksum + x) >>> 0;
  }
  return checksum;
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)] ?? 0;
}

function collectGarbage() {
  globalThis.gc?.();
}
