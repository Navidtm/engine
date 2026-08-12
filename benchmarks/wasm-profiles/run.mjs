import { spawnSync } from "node:child_process";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import { runBrowserBenchmarks } from "./run-browser.mjs";

const benchmarkRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = resolve(benchmarkRoot, "../..");
const outputPath = resolve(repositoryRoot, "benchmarks/results/wasm-profiles-latest.json");
const targetRoot = resolve(repositoryRoot, "target/wasm-profile-benchmark");
const profiles = [
  { name: "size", optLevel: "s" },
  { name: "performance", optLevel: "3" },
];
const transformEntities = 10_000;
const frameEntities = 10_000;
const warmupIterations = 10;
const sampleIterations = 30;
const browserRequested = process.argv.includes("--browser");

const commit = runText("git", ["rev-parse", "HEAD"]);
const dirty = runText("git", ["status", "--porcelain"]).length > 0;
const rustc = runText("rustc", ["-Vv"]);
const cargo = runText("cargo", ["-V"]);
const node = {
  version: process.version,
  v8: process.versions.v8,
  platform: process.platform,
  arch: process.arch,
};
const cpu = cpus()[0];

const results = [];
const browserArtifacts = [];
for (const profile of profiles) {
  const profileTarget = resolve(targetRoot, profile.name);
  const environment = {
    ...process.env,
    CARGO_TARGET_DIR: profileTarget,
    CARGO_PROFILE_RELEASE_OPT_LEVEL: profile.optLevel,
  };
  const buildStarted = performance.now();
  run("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown", "-p", "lume-wasm"], {
    env: environment,
  });
  const buildWallMs = performance.now() - buildStarted;
  const wasmPath = resolve(profileTarget, "wasm32-unknown-unknown/release/lume_wasm.wasm");
  const bytes = await readFile(wasmPath);
  const module = await WebAssembly.compile(bytes);
  browserArtifacts.push({ name: profile.name, wasmPath });

  const nativeOutput = resolve(profileTarget, "native-results.json");
  run("cargo", ["run", "--release", "-p", "lume-benchmarks", "--", "--output", nativeOutput], {
    env: environment,
  });
  const native = JSON.parse(await readFile(nativeOutput, "utf8"));

  results.push({
    profile,
    flags: {
      codegenUnits: 1,
      lto: "fat",
      panic: "abort",
      strip: true,
    },
    artifact: {
      path: relativePath(wasmPath),
      rawBytes: bytes.byteLength,
      gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
      brotliBytes: brotliCompressSync(bytes, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
      }).byteLength,
      buildWallMs,
    },
    startup: await benchmarkStartup(bytes, module),
    wasmRuntime: await benchmarkWasmRuntime(module),
    nativeCore: selectNativeResults(native.results),
  });
}

let browserRun = { environment: { status: "not-requested" }, profiles: {} };
if (browserRequested) {
  run("pnpm", ["-r", "--filter", "./packages/**", "build"]);
  browserRun = await runBrowserBenchmarks({
    repositoryRoot,
    artifacts: browserArtifacts,
    commit,
    entities: frameEntities,
  });
  for (const result of results) {
    const browserRuns = browserRun.profiles[result.profile.name];
    if (browserRuns !== undefined) result.browserRenderer = summarizeBrowserRuns(browserRuns);
  }
}

const report = {
  schemaVersion: 1,
  benchmark: "wasm-optimization-profiles",
  generatedAt: new Date().toISOString(),
  commit,
  dirty,
  environment: {
    os: { platform: platform(), release: release() },
    hardware: {
      cpu: cpu?.model ?? "unknown",
      logicalCores: cpus().length,
      totalMemoryBytes: totalmem(),
      freeMemoryBytesAtStart: freemem(),
    },
    rustc,
    cargo,
    node,
    browser: browserRun.environment,
  },
  methodology: {
    profiles: profiles.map(({ name, optLevel }) => ({ name, optLevel })),
    invariantFlags: { codegenUnits: 1, lto: "fat", panic: "abort", strip: true },
    transformEntities,
    frameEntities,
    warmupIterations,
    sampleIterations,
    startupSamples: 20,
    compression: { gzipLevel: 9, brotliQuality: 11 },
    notes: [
      "Build wall time is diagnostic and may include different incremental cache states.",
      "Node WASM measurements use V8 and exclude worker, SharedArrayBuffer, and WebGPU costs.",
      "Native core samples isolate systems, extraction, and visibility but are not WASM timings.",
      "The full WASM frame calls the production update ABI: systems, extraction, then visibility.",
      "Browser frame samples use the production worker, SharedArrayBuffer transport, and WebGPU renderer.",
    ],
  },
  profiles: results,
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Wrote WASM profile benchmark to ${relativePath(outputPath)}`);

async function benchmarkStartup(bytes, precompiledModule) {
  const compileMs = [];
  const instantiatePrecompiledMs = [];
  const compileAndInstantiateMs = [];
  for (let index = 0; index < 20; index += 1) {
    const compileBytes = bytes.slice();
    let started = performance.now();
    await WebAssembly.compile(compileBytes);
    compileMs.push(performance.now() - started);

    started = performance.now();
    await WebAssembly.instantiate(precompiledModule, {});
    instantiatePrecompiledMs.push(performance.now() - started);

    const startupBytes = bytes.slice();
    started = performance.now();
    await WebAssembly.instantiate(startupBytes, {});
    compileAndInstantiateMs.push(performance.now() - started);
  }
  return {
    compileMs,
    instantiatePrecompiledMs,
    compileAndInstantiateMs,
    summaries: {
      compile: summarize(compileMs),
      instantiatePrecompiled: summarize(instantiatePrecompiledMs),
      compileAndInstantiate: summarize(compileAndInstantiateMs),
    },
  };
}

async function benchmarkWasmRuntime(module) {
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports;
  const engine = exports.lume_engine_create(frameEntities + 2, frameEntities + 2);
  if (engine === 0) throw new Error("WASM engine allocation failed.");
  try {
    prepareScene(exports, engine, frameEntities);
    const transformBatch = createTransformBatch(exports, engine, transformEntities);
    const transformMs = sample(() => applyTransformBatch(exports, engine, transformBatch));
    const fullFrameMs = sample(() => {
      if (exports.lume_engine_update(engine) !== 1) throw new Error("WASM frame update failed.");
    });
    return {
      transformRangeMs: transformMs,
      fullCoreFrameMs: fullFrameMs,
      summaries: {
        transformRange: summarize(transformMs),
        fullCoreFrame: summarize(fullFrameMs),
      },
      finalCounts: {
        entities: exports.lume_engine_entity_count(engine),
        extractedInstances: exports.lume_render_instance_count(engine),
        visibleInstances: exports.lume_visible_count(engine),
      },
    };
  } finally {
    exports.lume_engine_destroy(engine);
  }
}

function prepareScene(exports, engine, count) {
  const material = count;
  const camera = count + 1;
  assertOne(exports.lume_engine_spawn(engine, material), "spawn material");
  assertOne(exports.lume_engine_add_material(engine, material, 0.3, 0.6, 1, 1), "add material");
  for (let index = 0; index < count; index += 1) {
    assertOne(exports.lume_engine_spawn(engine, index), "spawn mesh");
    assertOne(
      exports.lume_engine_add_transform(
        engine,
        index,
        (index % 100) * 0.1 - 5,
        Math.floor(index / 100) * 0.1 - 5,
        -20,
        0,
        0,
        0,
        1,
        1,
        1,
        1,
      ),
      "add transform",
    );
    assertOne(exports.lume_engine_add_mesh_renderer(engine, index, 2, material), "add mesh");
    assertOne(exports.lume_engine_add_bounds(engine, index, 0, 0, 0, 0.5), "add bounds");
  }
  assertOne(exports.lume_engine_spawn(engine, camera), "spawn camera");
  assertOne(
    exports.lume_engine_add_transform(engine, camera, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1),
    "add camera transform",
  );
  assertOne(
    exports.lume_engine_add_camera(engine, camera, Math.PI / 3, 0.1, 1_000, 16 / 9),
    "add camera",
  );
  assertOne(exports.lume_engine_update(engine), "warm scene update");
}

function createTransformBatch(exports, engine, count) {
  const memory = exports.memory;
  return {
    count,
    generations: new Uint32Array(
      memory.buffer,
      exports.lume_transform_update_generations_ptr(engine),
      count,
    ),
    masks: new Uint32Array(memory.buffer, exports.lume_transform_update_masks_ptr(engine), count),
    values: new Float32Array(
      memory.buffer,
      exports.lume_transform_update_values_ptr(engine),
      count * 10,
    ),
    starts: new Uint32Array(memory.buffer, exports.lume_transform_range_starts_ptr(engine), 1),
    counts: new Uint32Array(memory.buffer, exports.lume_transform_range_counts_ptr(engine), 1),
  };
}

function applyTransformBatch(exports, engine, batch) {
  batch.generations.fill(0);
  batch.masks.fill(1);
  for (let index = 0; index < batch.count; index += 1) {
    batch.values[index * 10] += 0.001;
  }
  batch.starts[0] = 0;
  batch.counts[0] = batch.count;
  if (exports.lume_engine_apply_transform_ranges(engine, 1) !== batch.count) {
    throw new Error("WASM transform batch did not apply every entity.");
  }
}

function sample(operation) {
  for (let index = 0; index < warmupIterations; index += 1) operation();
  const samples = [];
  for (let index = 0; index < sampleIterations; index += 1) {
    const started = performance.now();
    operation();
    samples.push(performance.now() - started);
  }
  return samples;
}

function selectNativeResults(results) {
  const selected = new Set([
    "transform_system_update",
    "render_world_extraction",
    "frustum_culling_100_percent",
    "frustum_culling_50_percent",
    "frustum_culling_10_percent",
    "frustum_culling_1_percent",
  ]);
  return results.filter((result) => selected.has(result.scenario));
}

function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return {
    meanMs: mean,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    minMs: sorted[0],
    maxMs: sorted.at(-1),
  };
}

function summarizeBrowserRuns(runs) {
  const measurements = runs.map((run) => run.measurements);
  return {
    runs,
    summaries: {
      initialization: summarize(measurements.map((entry) => entry.initializationMs)),
      firstRenderedFrame: summarize(measurements.map((entry) => entry.firstRenderedFrameMs)),
      frame: summarize(measurements.flatMap((entry) => entry.frameTimesMs)),
      cpu: summarize(measurements.flatMap((entry) => entry.cpuTimesMs)),
      bufferUploadCpu: summarize(measurements.flatMap((entry) => entry.bufferUploadCpuTimesMs)),
      framePreparationCpu: summarize(
        measurements.flatMap((entry) => entry.framePreparationCpuTimesMs),
      ),
    },
  };
}

function percentile(sorted, quantile) {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))];
}

function assertOne(value, operation) {
  if (value !== 1) throw new Error(`${operation} failed.`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: "inherit",
    ...options,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}.`);
}

function runText(command, args) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: "utf8" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}.`);
  return result.stdout.trim();
}

function relativePath(path) {
  return path.startsWith(repositoryRoot) ? path.slice(repositoryRoot.length + 1) : path;
}
