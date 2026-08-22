import { cpus, platform, release, totalmem } from "node:os";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { runBrowserBenchmarks } from "../wasm-profiles/run-browser.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const wasmPath = resolve(repositoryRoot, "packages/runtime/dist/lume_core.wasm");
const outputPath = resolve(repositoryRoot, "benchmarks/results/renderer-scalability-latest.json");
const commit = git("rev-parse", "HEAD");
const scenarios = [
  { name: "empty", entities: 0, parameters: { capacity: 4, visibleRatio: 0 } },
  {
    name: "randomized",
    entities: 10_000,
    parameters: { capacity: 10_004, visibleRatio: 0.5, layout: "random", seed: 0x6c75_6d65 },
  },
  ...[1_000, 10_000, 50_000, 100_000].map((entities) => ({
    name: `scale-${entities}`,
    entities,
    parameters: { capacity: entities + 4, visibleRatio: 1 },
  })),
  ...[0.01, 0.1, 0.5, 1].map((occupancy) => ({
    name: `occupancy-${occupancy}`,
    entities: Math.max(1_000, Math.floor(100_000 * occupancy)),
    parameters: { capacity: 100_004, visibleRatio: 0.5 },
  })),
  ...[0, 0.1, 0.5, 1].map((visibleRatio) => ({
    name: `visible-${visibleRatio}`,
    entities: 100_000,
    parameters: { capacity: 100_004, visibleRatio },
  })),
  ...[0.01, 0.1, 1].map((updateRatio) => ({
    name: `transform-dirty-${updateRatio}`,
    entities: 100_000,
    parameters: { capacity: 100_004, visibleRatio: 0.5, updateRatio },
  })),
  ...[0.01, 0.1, 1].map((boundsUpdateRatio) => ({
    name: `bounds-dirty-${boundsUpdateRatio}`,
    entities: 50_000,
    parameters: { capacity: 50_004, visibleRatio: 0.5, boundsUpdateRatio },
  })),
  ...[0.01, 0.1, 1].map((resourceUpdateRatio) => ({
    name: `resource-dirty-${resourceUpdateRatio}`,
    entities: 50_000,
    parameters: { capacity: 50_004, visibleRatio: 0.5, resourceUpdateRatio },
  })),
  ...[0.01, 0.1, 1].map((churnRatio) => ({
    name: `churn-${churnRatio}`,
    entities: 10_000,
    parameters: { capacity: 10_004, visibleRatio: 0.5, churnRatio },
  })),
  ...[1, 2, 4].map((cameraCount) => ({
    name: `cameras-${cameraCount}`,
    entities: 50_000,
    parameters: { capacity: 50_004, visibleRatio: 0.5, cameraCount },
  })),
];

const results = [];
for (const [index, scenario] of scenarios.entries()) {
  console.log(`[${index + 1}/${scenarios.length}] ${scenario.name}`);
  const artifacts = [
    {
      name: "cpu",
      wasmPath,
      parameters: { ...scenario.parameters, visibilityMode: "cpu" },
    },
    {
      name: "gpu",
      wasmPath,
      parameters: { ...scenario.parameters, visibilityMode: "gpu" },
    },
    {
      name: "auto",
      wasmPath,
      parameters: { ...scenario.parameters, visibilityMode: "auto" },
    },
  ];
  const browser = await runBrowserBenchmarks({
    repositoryRoot,
    artifacts,
    commit,
    entities: scenario.entities,
  });
  if (browser.environment.status !== "completed") {
    throw new Error(`${scenario.name}: ${browser.environment.reason ?? "browser run failed"}`);
  }
  const cpu = browser.profiles.cpu;
  const gpu = browser.profiles.gpu;
  const auto = browser.profiles.auto;
  for (const run of gpu) {
    if (
      run.measurements.gpuVisibleObjects !== run.measurements.visibleObjects ||
      run.measurements.gpuVisibilityHash !== run.measurements.cpuVisibilityHash
    ) {
      throw new Error(`${scenario.name}: CPU/GPU visibility membership mismatch`);
    }
  }
  results.push({
    ...scenario,
    runOrder: browser.environment.runOrder,
    summary: { cpu: summarize(cpu), gpu: summarize(gpu), auto: summarize(auto) },
    runs: { cpu, gpu, auto },
  });
}

const firstRun = results[0]?.runs.gpu[0];
const report = {
  schemaVersion: 1,
  benchmark: "renderer-scalability",
  generatedAt: new Date().toISOString(),
  commit,
  dirty: git("status", "--porcelain").length > 0,
  environment: {
    os: { platform: platform(), release: release() },
    hardware: {
      cpu: cpus()[0]?.model ?? "unknown",
      logicalCores: cpus().length,
      totalMemoryBytes: totalmem(),
      gpuAdapter: firstRun?.hardware.gpuAdapter ?? null,
    },
    node: { version: process.version, v8: process.versions.v8 },
    browser: firstRun?.browser ?? "unknown",
  },
  methodology: {
    warmupFrames: 60,
    sampleFrames: 180,
    resolution: [1280, 720],
    runOrder: "CPU/GPU/GPU/CPU/AUTO/AUTO per scenario in one controlled Chrome session",
    counts: [1_000, 10_000, 50_000, 100_000],
    occupancyRatios: [0.01, 0.1, 0.5, 1],
    visibleRatios: [0, 0.1, 0.5, 1],
    dirtyRatios: [0, 0.01, 0.1, 1],
    cameraCounts: [1, 2, 4],
    notes: [
      "CPU is the production reference policy; GPU is the explicit compute/indirect candidate.",
      "Every GPU timing sample is accompanied by a pull-sampled visible count and order-independent membership hash checked against CPU visibility.",
      "Empty and deterministic seeded-random scenes extend the ratio matrix with boundary and irregular membership coverage.",
      "A missed frame is a frame-time sample above 1.5 times the 60 Hz interval (25 ms); raw samples and p50/p95/p99/max remain retained.",
      "500k and 1M are measured by the native matrix; browser cases stop at 100k for the controlled device budget.",
    ],
  },
  scenarios: results,
};

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Wrote ${outputPath}`);

function summarize(runs) {
  const frameTimes = runs.flatMap((run) => run.measurements.frameTimesMs);
  const missedFrames = frameTimes.filter((value) => value > (1_000 / 60) * 1.5).length;
  return {
    frameTimeMedianMs: median(frameTimes),
    frameTimeP95Ms: percentile(frameTimes, 0.95),
    frameTimeP99Ms: percentile(frameTimes, 0.99),
    frameTimeMaxMs: Math.max(...frameTimes),
    missedFrames,
    missedFrameRate: frameTimes.length === 0 ? 0 : missedFrames / frameTimes.length,
    cpuTimeMedianMs: median(runs.flatMap((run) => run.measurements.cpuTimesMs)),
    framePreparationMedianMs: median(
      runs.flatMap((run) => run.measurements.framePreparationCpuTimesMs),
    ),
    uploadBytesMedian: median(runs.flatMap((run) => run.measurements.bufferUploadBytes)),
    bufferWritesMedian: median(runs.flatMap((run) => run.measurements.bufferWriteCounts)),
    gpuTimeMs: runs.at(-1)?.measurements.gpuFrameTimeMs ?? null,
    gpuBufferBytes: runs.at(-1)?.measurements.gpuBufferBytes ?? null,
    drawCalls: runs.at(-1)?.measurements.drawCalls ?? 0,
    computeDispatches: runs.at(-1)?.measurements.computeDispatches ?? 0,
    indirectDrawCalls: runs.at(-1)?.measurements.indirectDrawCalls ?? 0,
    activeObjects: runs.at(-1)?.measurements.activeObjects ?? 0,
    testedObjects: runs.at(-1)?.measurements.testedObjects ?? 0,
    visibleObjects: runs.at(-1)?.measurements.visibleObjects ?? 0,
    gpuVisibleObjects: runs.at(-1)?.measurements.gpuVisibleObjects ?? null,
    cpuVisibilityHash: runs.at(-1)?.measurements.cpuVisibilityHash ?? null,
    gpuVisibilityHash: runs.at(-1)?.measurements.gpuVisibilityHash ?? null,
    uploadBytesByDomain: runs.at(-1)?.measurements.uploadBytesByDomain ?? null,
  };
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? null;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function git(...args) {
  const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed.`);
  return result.stdout.trim();
}
