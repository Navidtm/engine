import { access, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "lume-packaging-"));
const packDirectory = join(temporaryRoot, "packs");
const consumerDirectory = join(temporaryRoot, "consumer");

try {
  await mkdir(packDirectory, { recursive: true });
  await mkdir(consumerDirectory, { recursive: true });
  runPnpm(["-r", "--filter", "./packages/**", "build"], repositoryRoot);
  const packages = ["renderer", "scene", "runtime", "api"];
  const archives = new Map();
  for (const packageName of packages) {
    runPnpm(
      ["pack", "--pack-destination", packDirectory],
      resolve(repositoryRoot, `packages/${packageName}`),
    );
    const archive = (await readdir(packDirectory)).find(
      (entry) => entry.startsWith(`lume-${packageName}-`) && entry.endsWith(".tgz"),
    );
    if (archive === undefined) throw new Error(`pnpm pack did not create @lume/${packageName}.`);
    archives.set(packageName, join(packDirectory, archive));
  }

  await writeFile(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "lume-packaged-consumer",
        private: true,
        type: "module",
        dependencies: Object.fromEntries(
          packages.map((name) => [`@lume/${name}`, `file:${archives.get(name)}`]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(consumerDirectory, "pnpm-workspace.yaml"),
    `packages: []\n\noverrides:\n${packages
      .map((name) => `  "@lume/${name}": "file:${archives.get(name)}"`)
      .join("\n")}\n`,
  );
  runPnpm(["install", "--offline", "--ignore-scripts"], consumerDirectory);

  const installedWasm = join(consumerDirectory, "node_modules/@lume/runtime/dist/lume_core.wasm");
  await access(installedWasm);
  if ((await stat(installedWasm)).size === 0) throw new Error("Packaged WASM artifact is empty.");

  const nativeConsumer = join(consumerDirectory, "native-consumer.mjs");
  await writeFile(
    nativeConsumer,
    `import { readFile } from "node:fs/promises";
import { getLumeWasmUrl, LUME_WASM_ABI_VERSION } from "@lume/runtime/wasm-url";

const url = getLumeWasmUrl();
const bytes = await readFile(url);
const { instance } = await WebAssembly.instantiate(bytes, {});
if (instance.exports.lume_abi_version() !== LUME_WASM_ABI_VERSION) {
  throw new Error("Packaged runtime and WASM ABI versions differ.");
}
`,
  );
  run(process.execPath, [nativeConsumer], consumerDirectory);

  await writeFile(
    join(consumerDirectory, "index.html"),
    '<!doctype html><html><body><script type="module" src="/src/main.js"></script></body></html>\n',
  );
  const sourceDirectory = join(consumerDirectory, "src");
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(
    join(sourceDirectory, "main.js"),
    `import { createEngine } from "@lume/api";
import { getLumeWasmUrl } from "@lume/runtime/wasm-url";

globalThis.__LUME_PACKAGED_API__ = createEngine;
document.body.dataset.wasmUrl = getLumeWasmUrl().href;
`,
  );
  run(resolve(repositoryRoot, "node_modules/.bin/vite"), ["build"], consumerDirectory);

  const emittedFiles = await listFiles(join(consumerDirectory, "dist"));
  const emittedWasm = emittedFiles.find((path) => path.endsWith(".wasm"));
  if (emittedWasm === undefined) {
    throw new Error("Vite did not emit the package-owned WASM artifact.");
  }
  if ((await stat(emittedWasm)).size === 0) throw new Error("Vite emitted an empty WASM artifact.");

  console.log(`Verified packed native ESM and Vite consumers with ${basename(emittedWasm)}.`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function runPnpm(arguments_, cwd) {
  const pnpmScript = process.env.npm_execpath;
  if (pnpmScript === undefined) throw new Error("npm_execpath is unavailable; run through pnpm.");
  run(process.execPath, [pnpmScript, ...arguments_], cwd);
}

function run(command, arguments_, cwd) {
  const result = spawnSync(command, arguments_, { cwd, stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}.`);
  }
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else files.push(path);
  }
  return files;
}
