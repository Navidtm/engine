import { cpus, platform, release, totalmem } from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { runBrowserBenchmarks } from "../wasm-profiles/run-browser.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const outputPath = resolve(
  repositoryRoot,
  "benchmarks/results/incremental-render-world-latest.json",
);
const baselineWasm = argument("--baseline-wasm");
const baselineNative = await readJson(argument("--baseline-native"));
const candidateNative = await readJson(argument("--candidate-native"));
const candidateWasm = resolve(repositoryRoot, "packages/runtime/dist/lume_core.wasm");
const counts = [10_000, 50_000, 100_000];
const updateRatios = [0, 0.01, 0.1, 1];
const baselineCommit = git("rev-parse", "master");
const candidateCommit = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain").length > 0;
const scenarios = [];

for (const entities of counts) {
  for (const updateRatio of updateRatios) {
    const artifacts = [
      { name: "linear-rebuild", wasmPath: baselineWasm, updateRatio },
      { name: "epoch-reuse", wasmPath: candidateWasm, updateRatio },
    ];
    const browser = await runBrowserBenchmarks({
      repositoryRoot,
      artifacts,
      commit: candidateCommit,
      entities,
    });
    if (browser.environment.status !== "completed") {
      throw new Error(`Browser comparison failed: ${browser.environment.reason ?? "unknown"}`);
    }
    scenarios.push({
      entities,
      updateRatio,
      runOrder: browser.environment.runOrder,
      before: browser.profiles["linear-rebuild"],
      after: browser.profiles["epoch-reuse"],
    });
  }
}

const firstRun = scenarios[0]?.after[0];
const report = {
  schemaVersion: 1,
  benchmark: "incremental-render-world-extraction",
  generatedAt: new Date().toISOString(),
  baselineCommit,
  candidateCommit,
  dirty,
  environment: {
    os: { platform: platform(), release: release() },
    hardware: {
      cpu: cpus()[0]?.model ?? "unknown",
      logicalCores: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    node: { version: process.version, v8: process.versions.v8 },
    browser: firstRun?.browser ?? "unknown",
    gpu: firstRun?.hardware.gpuAdapter ?? null,
  },
  methodology: {
    counts,
    updateRatios,
    warmupFrames: 60,
    sampleFrames: 180,
    resolution: [1280, 720],
    order: "ABBA per entity-count/update-ratio pair in one Chrome session",
    notes: [
      "The baseline and candidate use separately built WASM artifacts with identical TypeScript runtime and renderer code.",
      "Raw total worker/render CPU, preparation, GPU, upload, frame, and memory samples are retained.",
      "Native extraction-only results are recorded separately because the browser worker timer covers the complete core and renderer submission path.",
    ],
  },
  native: {
    before: extractionResults(baselineNative),
    after: extractionResults(candidateNative),
  },
  scenarios,
};

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Wrote ${outputPath}`);

function argument(name) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined) throw new Error(`${name} <path> is required.`);
  return resolve(value);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function extractionResults(report) {
  return {
    generatedAtUnixMs: report.generatedAtUnixMs,
    hardware: report.hardware,
    configuration: report.configuration,
    results: report.results.filter((result) =>
      result.scenario.startsWith("render_world_extraction"),
    ),
  };
}

function git(...args) {
  const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed.`);
  return result.stdout.trim();
}
