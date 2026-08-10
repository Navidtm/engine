import { copyFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const build = spawnSync(
  "cargo",
  ["build", "--release", "--target", "wasm32-unknown-unknown", "-p", "lume-wasm"],
  { cwd: repositoryRoot, stdio: "inherit" },
);
if (build.error !== undefined) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const targetRoot = process.env.CARGO_TARGET_DIR
  ? resolve(repositoryRoot, process.env.CARGO_TARGET_DIR)
  : resolve(repositoryRoot, "target");
const source = resolve(targetRoot, "wasm32-unknown-unknown/release/lume_wasm.wasm");
const destination = resolve(repositoryRoot, "packages/runtime/dist/lume_core.wasm");
await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
console.log(`Packaged ${source} -> ${destination}`);
