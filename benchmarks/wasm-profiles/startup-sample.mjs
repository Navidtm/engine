import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const [mode, wasmPath] = process.argv.slice(2);
if (wasmPath === undefined) throw new Error("Expected a startup mode and WASM artifact path.");

const bytes = await readFile(wasmPath);
let duration;
if (mode === "compile") {
  const started = performance.now();
  await WebAssembly.compile(bytes);
  duration = performance.now() - started;
} else if (mode === "instantiate") {
  const module = await WebAssembly.compile(bytes);
  const started = performance.now();
  await WebAssembly.instantiate(module, {});
  duration = performance.now() - started;
} else if (mode === "combined") {
  const started = performance.now();
  await WebAssembly.instantiate(bytes, {});
  duration = performance.now() - started;
} else {
  throw new Error(`Unknown startup mode: ${mode}`);
}

console.log(duration);
