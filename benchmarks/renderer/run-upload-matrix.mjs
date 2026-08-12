import { cpus, platform, release, totalmem } from "node:os";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { runBrowserBenchmarks } from "../wasm-profiles/run-browser.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const outputPath = resolve(
  repositoryRoot,
  "benchmarks/results/persistent-instance-upload-latest.json",
);
const wasmPath = resolve(repositoryRoot, "packages/runtime/dist/lume_core.wasm");
const counts = [1_000, 10_000, 50_000, 100_000];
const updateRatios = [0, 0.01, 0.1, 1];
const commit = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain").length > 0;
const scenarios = [];

for (const count of counts) {
  const artifacts = updateRatios.map((updateRatio, index) => ({
    name: `count-${count}-ratio-${index}`,
    wasmPath,
    updateRatio,
  }));
  const browser = await runBrowserBenchmarks({
    repositoryRoot,
    artifacts,
    commit,
    entities: count,
  });
  if (browser.environment.status !== "completed") {
    throw new Error(`Browser matrix failed: ${browser.environment.reason ?? "unknown error"}`);
  }
  for (const artifact of artifacts) {
    scenarios.push({
      entities: count,
      updateRatio: artifact.updateRatio,
      runs: browser.profiles[artifact.name],
    });
  }
}

const previous = JSON.parse(
  spawnSync("git", ["show", "master:benchmarks/results/wasm-profiles-latest.json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).stdout,
);
const previousPerformance = previous.profiles.find(
  (profile) => profile.profile.name === "performance",
);
const report = {
  schemaVersion: 1,
  benchmark: "persistent-instance-upload",
  generatedAt: new Date().toISOString(),
  commit,
  dirty,
  environment: {
    os: { platform: platform(), release: release() },
    hardware: {
      cpu: cpus()[0]?.model ?? "unknown",
      logicalCores: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    node: { version: process.version, v8: process.versions.v8 },
    browser: scenarios[0]?.runs[0]?.browser ?? "unknown",
    gpu: scenarios[0]?.runs[0]?.hardware.gpuAdapter ?? null,
  },
  methodology: {
    counts,
    updateRatios,
    warmupFrames: 60,
    sampleFrames: 180,
    resolution: [1280, 720],
    notes: [
      "Every after scenario retains raw per-frame upload, CPU, and frame samples.",
      "The before implementation unconditionally wrote visibleCount * 80 instance bytes and 128 camera bytes every frame.",
      "The committed before browser samples are linked rather than relabeled or regenerated after the change.",
    ],
  },
  before: {
    sourceCommit: previous.commit,
    sourceReport: "benchmarks/results/wasm-profiles-latest.json",
    scenario: "10,000 static indexed cubes",
    instanceUploadBytesPerFrame: 800_000,
    cameraUploadBytesPerFrame: 128,
    totalUploadBytesPerFrame: 800_128,
    browserRenderer: previousPerformance.browserRenderer,
  },
  after: { scenarios },
};

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Wrote ${outputPath}`);

function git(...args) {
  const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed.`);
  return result.stdout.trim();
}
