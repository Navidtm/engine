import { chromium } from "@playwright/test";
import { cpus, platform, release, totalmem } from "node:os";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { generateGridGlb } from "../../scripts/generate-grid-glb.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const generatedRoot = resolve(import.meta.dirname, "dist/generated");
const outputPath = resolve(repositoryRoot, "benchmarks/results/asset-pipeline-latest.json");
const port = 4_175;
const fixtures = [
  fixture("small-u16", "small", 32, 32, 5123, undefined, 5, 3),
  fixture("small-u32", "small", 32, 32, 5125, undefined, 5, 3),
  fixture("medium-u16", "medium", 224, 224, 5123, undefined, 3, 2),
  fixture("medium-u32", "medium", 317, 316, 5125, 300_000, 3, 2),
  fixture("large-u32", "large", 1_001, 1_000, 5125, 3_000_000, 1, 1),
];

await rm(generatedRoot, { recursive: true, force: true });
await mkdir(generatedRoot, { recursive: true });
for (const entry of fixtures) await writeFile(resolve(generatedRoot, entry.file), entry.bytes);
await writeFile(
  resolve(generatedRoot, "manifest.json"),
  `${JSON.stringify({ scenarios: fixtures.map(manifestEntry) }, null, 2)}\n`,
);

const commit = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain").length > 0;
const server = spawn(
  "pnpm",
  ["--filter", "@lume/benchmark-assets", "preview", "--port", String(port)],
  { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
);
let browser;
try {
  await waitForServer(`http://127.0.0.1:${port}`);
  browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}`);
  const result = await page.evaluate(async () => {
    const pending = globalThis.__LUME_ASSET_BENCHMARK_RESULT__;
    if (pending === undefined) throw new Error("Asset benchmark hook was not installed.");
    return pending;
  });
  const report = {
    schemaVersion: 1,
    benchmark: "milestone-7-asset-pipeline",
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
      browser: browser.version(),
      userAgent: result.userAgent,
      gpu: result.gpu,
      crossOriginIsolated: result.crossOriginIsolated,
    },
    methodology: {
      resolution: [320, 180],
      directDecodeWarmups: 3,
      fixtureGeneration: "scripts/generate-grid-glb.mjs",
      notes: [
        "Direct decoder samples run on the browser main thread only to isolate constrained-profile validation and decode cost.",
        "Promise latency covers worker fetch/read, decode, resource admission, and transactional WebGPU upload.",
        "Worker timing diagnostics are cold-path clocks published only through pull-based statistics.",
        "The large case uses UNSIGNED_INT because its vertex count exceeds the UNSIGNED_SHORT addressable range.",
        "Steady-state message delta subtracts the single get-stats request itself.",
      ],
    },
    scenarios: result.scenarios,
  };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Wrote ${outputPath}\n`);
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await rm(generatedRoot, { recursive: true, force: true });
}

function fixture(
  name,
  classification,
  columns,
  rows,
  indexComponentType,
  maxIndices,
  decodeSamples,
  loadSamples,
) {
  const generated = generateGridGlb({ columns, rows, indexComponentType, maxIndices });
  const file = `${name}.glb`;
  return {
    name,
    class: classification,
    url: `/generated/${file}`,
    file,
    ...generated.metadata,
    decodeSamples,
    loadSamples,
    bytes: generated.bytes,
  };
}

function manifestEntry(entry) {
  return {
    name: entry.name,
    class: entry.class,
    url: entry.url,
    vertexCount: entry.vertexCount,
    indexCount: entry.indexCount,
    indexComponentType: entry.indexComponentType,
    encodedBytes: entry.encodedBytes,
    decodedBytes: entry.decodedBytes,
    decodeSamples: entry.decodeSamples,
    loadSamples: entry.loadSamples,
  };
}

async function waitForServer(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Preview server is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("Asset benchmark preview server did not become ready.");
}

function git(...args) {
  const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed.`);
  return result.stdout.trim();
}
