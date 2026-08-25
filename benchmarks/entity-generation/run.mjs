import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import {
  allocateSharedRuntimeMemory,
  createSharedCommandDecoder,
  decodeSharedCommand,
  drainSharedCommands,
  writeSharedCommand,
} from "../.runtime-dist/benchmark-internals.mjs";

const INDEX_BITS = 20;
const MAX_GENERATION = (1 << (32 - INDEX_BITS)) - 1;
const REUSE_OPERATIONS = 1_000_000;
const REUSE_POOL_CAPACITY = 256;
const VALIDATION_OPERATIONS = 5_000_000;
const ATOMIC_OPERATIONS = 1_000_000;
const STRUCTURAL_DECODE_OPERATIONS = 1_000_000;
const STRUCTURAL_RETAINED_COMMANDS = 100_000;
const WARMUP_SAMPLES = 5;
const MEASURED_SAMPLES = 15;
const output = new URL("../results/entity-generation-latest.json", import.meta.url);

const lifecycleResults = [
  benchmarkLifecycle("packed-20-12-wrap", createPackedWrapCycle),
  benchmarkLifecycle("packed-20-12-retire", createPackedRetireCycle),
  benchmarkLifecycle("split-index-u32-generation-u32", createSplitWideCycle),
];
const validationResults = [
  benchmarkValidation("packed-20-12", createPacked20_12Validation),
  benchmarkValidation("packed-16-16", createPacked16_16Validation),
  benchmarkValidation("split-u32-u32", createSplitWideValidation),
  benchmarkValidation("packed-biguint64", createBigUint64Validation),
];
const atomicsResults = [
  benchmarkAtomics("packed-int32-publication", createPackedInt32Atomics),
  benchmarkAtomics("split-two-int32-publications", createSplitInt32Atomics),
  benchmarkAtomics("packed-biguint64-publication", createBigUint64Atomics),
];
const memoryResults = [10_000, 100_000, 1_000_000].flatMap((capacity) => [
  memoryRecord("packed-20-12-wrap", capacity, 2, 56, 4, 1_048_576),
  memoryRecord("packed-20-12-retire", capacity, 2, 56, 4, 1_048_576),
  memoryRecord("packed-16-16", capacity, 2, 56, 4, 65_536),
  memoryRecord("split-u32-u32", capacity, 4, 60, 8, 1_048_576),
]);
const structuralRecord = createStructuralRecord();
const sharedCommandDecoder = createSharedCommandDecoder();
const structuralDecodeResults = [
  benchmarkStructuralDecode("allocating-command-union", () =>
    decodeSharedCommand(...structuralRecord),
  ),
  benchmarkStructuralDecode("reused-command-record", () =>
    sharedCommandDecoder.decode(...structuralRecord),
  ),
];

const report = {
  schemaVersion: 2,
  benchmark: "entity-generation-strategies",
  generatedAt: new Date().toISOString(),
  environment: {
    runtime: "node",
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
  },
  workload: {
    reuseOperations: REUSE_OPERATIONS,
    reusePoolCapacity: REUSE_POOL_CAPACITY,
    validationOperations: VALIDATION_OPERATIONS,
    atomicOperations: ATOMIC_OPERATIONS,
    structuralDecodeOperations: STRUCTURAL_DECODE_OPERATIONS,
    structuralRetainedCommands: STRUCTURAL_RETAINED_COMMANDS,
    warmupSamples: WARMUP_SAMPLES,
    measuredSamples: MEASURED_SAMPLES,
  },
  notes: [
    "Lifecycle samples model a LIFO hot slot, matching the production allocator's worst realistic concentration of churn.",
    "Validation samples isolate identity decoding/comparison in Node; they are not browser or WASM timings.",
    "Memory records are deterministic layout accounting, not process heap measurements.",
    "The split layout keeps the existing 64-byte structural record by consuming one currently spare word.",
    "Structural decode uses the production shared-memory record and forces decoded values to escape during timing.",
    "Retained heap deltas compare 100,000 references after a full GC; they are Node/V8 measurements, not browser allocation counts.",
  ],
  lifecycleResults,
  validationResults,
  atomicsResults,
  structuralDecodeResults,
  memoryResults,
};

await mkdir(new URL("../results/", import.meta.url), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`wrote ${output.pathname}`);

function benchmarkLifecycle(strategy, createOperation) {
  for (let sample = 0; sample < WARMUP_SAMPLES; sample += 1) createOperation()();
  const samplesMs = [];
  let checksum = 0;
  let retiredSlots = 0;
  for (let sample = 0; sample < MEASURED_SAMPLES; sample += 1) {
    const operation = createOperation();
    const started = performance.now();
    const result = operation();
    samplesMs.push(performance.now() - started);
    checksum ^= result.checksum;
    retiredSlots = result.retiredSlots;
  }
  return {
    strategy,
    operations: REUSE_OPERATIONS,
    poolCapacity: REUSE_POOL_CAPACITY,
    medianMs: median(samplesMs),
    minMs: Math.min(...samplesMs),
    maxMs: Math.max(...samplesMs),
    retiredSlots,
    runtimeAllocationsPerCycle: 0,
    checksum,
  };
}

function createPackedWrapCycle() {
  const generations = new Uint16Array(REUSE_POOL_CAPACITY);
  const free = initializedFreeList();
  let freeCount = REUSE_POOL_CAPACITY;
  return () => {
    let checksum = 0;
    for (let operation = 0; operation < REUSE_OPERATIONS; operation += 1) {
      const index = free[--freeCount] ?? 0;
      const generation = generations[index] ?? 0;
      checksum = (checksum + (((generation << INDEX_BITS) | index) >>> 0)) >>> 0;
      generations[index] = (generation + 1) & MAX_GENERATION;
      free[freeCount++] = index;
    }
    return { checksum, retiredSlots: 0 };
  };
}

function createPackedRetireCycle() {
  const generations = new Uint16Array(REUSE_POOL_CAPACITY);
  const free = initializedFreeList();
  let freeCount = REUSE_POOL_CAPACITY;
  return () => {
    let retiredSlots = 0;
    let checksum = 0;
    for (let operation = 0; operation < REUSE_OPERATIONS; operation += 1) {
      const index = free[--freeCount] ?? 0;
      const generation = generations[index] ?? 0;
      checksum = (checksum + (((generation << INDEX_BITS) | index) >>> 0)) >>> 0;
      if (generation === MAX_GENERATION) {
        retiredSlots += 1;
      } else {
        generations[index] = generation + 1;
        free[freeCount++] = index;
      }
    }
    return { checksum, retiredSlots };
  };
}

function createSplitWideCycle() {
  const generations = new Uint32Array(REUSE_POOL_CAPACITY);
  const free = initializedFreeList();
  let freeCount = REUSE_POOL_CAPACITY;
  return () => {
    let checksum = 0;
    for (let operation = 0; operation < REUSE_OPERATIONS; operation += 1) {
      const index = free[--freeCount] ?? 0;
      const generation = generations[index] ?? 0;
      checksum = (checksum + (index ^ generation)) >>> 0;
      generations[index] = (generation + 1) >>> 0;
      free[freeCount++] = index;
    }
    return { checksum, retiredSlots: 0 };
  };
}

function initializedFreeList() {
  const free = new Uint32Array(REUSE_POOL_CAPACITY);
  for (let index = 0; index < REUSE_POOL_CAPACITY; index += 1) free[index] = index;
  return free;
}

function benchmarkValidation(strategy, createOperation) {
  for (let sample = 0; sample < WARMUP_SAMPLES; sample += 1) createOperation()();
  const samplesMs = [];
  let checksum = 0;
  for (let sample = 0; sample < MEASURED_SAMPLES; sample += 1) {
    const operation = createOperation();
    const started = performance.now();
    checksum ^= operation();
    samplesMs.push(performance.now() - started);
  }
  const medianMs = median(samplesMs);
  return {
    strategy,
    operations: VALIDATION_OPERATIONS,
    medianMs,
    nanosecondsPerValidation: (medianMs * 1_000_000) / VALIDATION_OPERATIONS,
    minMs: Math.min(...samplesMs),
    maxMs: Math.max(...samplesMs),
    checksum,
  };
}

function createPacked20_12Validation() {
  const capacity = 4_096;
  const generations = new Uint16Array(capacity);
  const identities = new Uint32Array(capacity);
  for (let index = 0; index < capacity; index += 1) {
    generations[index] = index & MAX_GENERATION;
    const candidateGeneration = (generations[index] ?? 0) + (index % 16 === 0 ? 1 : 0);
    identities[index] = ((candidateGeneration << 20) | index) >>> 0;
  }
  return () => {
    let checksum = 0;
    for (let operation = 0; operation < VALIDATION_OPERATIONS; operation += 1) {
      const candidate = Math.imul(operation, 2_654_435_761) & (capacity - 1);
      const identity = identities[candidate] ?? 0;
      const index = identity & 0x000f_ffff;
      checksum += (generations[index] ?? -1) === identity >>> 20 ? 1 : 0;
    }
    return checksum;
  };
}

function createPacked16_16Validation() {
  const capacity = 4_096;
  const generations = new Uint16Array(capacity);
  const identities = new Uint32Array(capacity);
  for (let index = 0; index < capacity; index += 1) {
    generations[index] = (index * 7) & 0xffff;
    const candidateGeneration = (generations[index] ?? 0) + (index % 16 === 0 ? 1 : 0);
    identities[index] = ((candidateGeneration << 16) | index) >>> 0;
  }
  return () => {
    let checksum = 0;
    for (let operation = 0; operation < VALIDATION_OPERATIONS; operation += 1) {
      const candidate = Math.imul(operation, 2_654_435_761) & (capacity - 1);
      const identity = identities[candidate] ?? 0;
      const index = identity & 0x0000_ffff;
      checksum += (generations[index] ?? -1) === identity >>> 16 ? 1 : 0;
    }
    return checksum;
  };
}

function createSplitWideValidation() {
  const capacity = 4_096;
  const currentGenerations = new Uint32Array(capacity);
  const candidateIndices = new Uint32Array(capacity);
  const candidateGenerations = new Uint32Array(capacity);
  for (let index = 0; index < capacity; index += 1) {
    currentGenerations[index] = (index * 1_048_583) >>> 0;
    candidateIndices[index] = index;
    candidateGenerations[index] =
      ((currentGenerations[index] ?? 0) + (index % 16 === 0 ? 1 : 0)) >>> 0;
  }
  return () => {
    let checksum = 0;
    for (let operation = 0; operation < VALIDATION_OPERATIONS; operation += 1) {
      const candidate = Math.imul(operation, 2_654_435_761) & (capacity - 1);
      const index = candidateIndices[candidate] ?? capacity;
      checksum += (currentGenerations[index] ?? -1) === candidateGenerations[candidate] ? 1 : 0;
    }
    return checksum;
  };
}

function createBigUint64Validation() {
  const capacity = 4_096;
  const currentGenerations = new Uint32Array(capacity);
  const identities = new BigUint64Array(capacity);
  for (let index = 0; index < capacity; index += 1) {
    const generation = (index * 1_048_583) >>> 0;
    currentGenerations[index] = generation;
    const candidateGeneration = (generation + (index % 16 === 0 ? 1 : 0)) >>> 0;
    identities[index] = (BigInt(candidateGeneration) << 20n) | BigInt(index);
  }
  return () => {
    let checksum = 0;
    for (let operation = 0; operation < VALIDATION_OPERATIONS; operation += 1) {
      const candidate = Math.imul(operation, 2_654_435_761) & (capacity - 1);
      const identity = identities[candidate] ?? 0n;
      const index = Number(identity & 0x000f_ffffn);
      checksum += (currentGenerations[index] ?? -1) === Number(identity >> 20n) ? 1 : 0;
    }
    return checksum;
  };
}

function benchmarkAtomics(strategy, createOperation) {
  for (let sample = 0; sample < WARMUP_SAMPLES; sample += 1) createOperation()();
  const samplesMs = [];
  let checksum = 0;
  for (let sample = 0; sample < MEASURED_SAMPLES; sample += 1) {
    const operation = createOperation();
    const started = performance.now();
    checksum ^= operation();
    samplesMs.push(performance.now() - started);
  }
  return {
    strategy,
    operations: ATOMIC_OPERATIONS,
    medianMs: median(samplesMs),
    minMs: Math.min(...samplesMs),
    maxMs: Math.max(...samplesMs),
    checksum,
  };
}

function createPackedInt32Atomics() {
  const publication = new Int32Array(new SharedArrayBuffer(4));
  return () => {
    let checksum = 0;
    for (let operation = 0; operation < ATOMIC_OPERATIONS; operation += 1) {
      Atomics.store(publication, 0, (operation << 4) | (operation & 0x0f));
      checksum = (checksum + Atomics.load(publication, 0)) >>> 0;
    }
    return checksum;
  };
}

function createSplitInt32Atomics() {
  const publication = new Int32Array(new SharedArrayBuffer(8));
  return () => {
    let checksum = 0;
    for (let operation = 0; operation < ATOMIC_OPERATIONS; operation += 1) {
      Atomics.store(publication, 0, operation);
      Atomics.store(publication, 1, operation & 0x0f);
      checksum = (checksum + Atomics.load(publication, 0) + Atomics.load(publication, 1)) >>> 0;
    }
    return checksum;
  };
}

function createBigUint64Atomics() {
  const publication = new BigUint64Array(new SharedArrayBuffer(8));
  return () => {
    let checksum = 0;
    for (let operation = 0; operation < ATOMIC_OPERATIONS; operation += 1) {
      Atomics.store(publication, 0, (BigInt(operation) << 4n) | BigInt(operation & 0x0f));
      checksum = (checksum + Number(Atomics.load(publication, 0) & 0xffff_ffffn)) >>> 0;
    }
    return checksum;
  };
}

function createStructuralRecord() {
  const views = allocateSharedRuntimeMemory(4, 1);
  writeSharedCommand(views, {
    type: "add-transform",
    entity: 1,
    position: [1, 2, 3],
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
  });
  let record;
  drainSharedCommands(views, (opcode, identity, offset, shared) => {
    record = [opcode, identity, offset, shared];
  });
  if (record === undefined) throw new Error("Structural benchmark record was not produced.");
  return record;
}

function benchmarkStructuralDecode(strategy, decode) {
  for (let sample = 0; sample < WARMUP_SAMPLES; sample += 1) {
    runStructuralDecode(decode);
  }
  const samplesMs = [];
  let checksum = 0;
  for (let sample = 0; sample < MEASURED_SAMPLES; sample += 1) {
    const started = performance.now();
    checksum ^= runStructuralDecode(decode);
    samplesMs.push(performance.now() - started);
  }
  const retainedHeapDeltaBytes = measureRetainedStructuralHeap(decode);
  return {
    strategy,
    operations: STRUCTURAL_DECODE_OPERATIONS,
    medianMs: median(samplesMs),
    minMs: Math.min(...samplesMs),
    maxMs: Math.max(...samplesMs),
    retainedCommands: STRUCTURAL_RETAINED_COMMANDS,
    retainedHeapDeltaBytes,
    retainedHeapBytesPerCommand: retainedHeapDeltaBytes / STRUCTURAL_RETAINED_COMMANDS,
    checksum,
  };
}

function runStructuralDecode(decode) {
  let checksum = 0;
  for (let operation = 0; operation < STRUCTURAL_DECODE_OPERATIONS; operation += 1) {
    const command = decode();
    globalThis.__lumeStructuralCommandSink = command;
    checksum += command.entity + command.position[0];
  }
  return checksum;
}

function measureRetainedStructuralHeap(decode) {
  if (typeof globalThis.gc !== "function") {
    throw new Error("Run this benchmark with --expose-gc.");
  }
  const retained = new Array(STRUCTURAL_RETAINED_COMMANDS).fill(null);
  globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  for (let index = 0; index < retained.length; index += 1) retained[index] = decode();
  globalThis.gc();
  const after = process.memoryUsage().heapUsed;
  retained.fill(null);
  globalThis.gc();
  return Math.max(0, after - before);
}

function memoryRecord(
  strategy,
  capacity,
  generationBytes,
  sabBytesPerSlot,
  rustEntityBytes,
  maxEntities,
) {
  const effectiveCapacity = Math.min(capacity, maxEntities);
  const commandCapacity = Math.min(effectiveCapacity, 1_024);
  return {
    strategy,
    requestedCapacity: capacity,
    effectiveCapacity,
    maxEntities,
    typescriptGenerationBytes: effectiveCapacity * generationBytes,
    sharedTransformBytes: 64 + effectiveCapacity * sabBytesPerSlot + commandCapacity * 64,
    structuralRecordBytes: 64,
    rustEntityBytes,
  };
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)] ?? 0;
}
