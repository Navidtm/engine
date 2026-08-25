import { basename, resolve } from "node:path";

import { defineConfig } from "tsdown";

const packageEntries = {
  assets: {
    index: "src/index.ts",
  },
  api: {
    index: "src/index.ts",
    advanced: "src/advanced.ts",
  },
  renderer: {
    index: "src/index.ts",
  },
  runtime: {
    index: "src/index.ts",
    "wasm-url": "src/wasm-url.ts",
    worker: "src/worker.ts",
  },
  scene: {
    index: "src/index.ts",
  },
} as const;

const packageDirectory = process.cwd();
const packageName = basename(packageDirectory);
const relativeEntries = packageEntries[packageName as keyof typeof packageEntries];

if (relativeEntries === undefined) {
  throw new Error(`No tsdown entries are configured for package: ${packageName}`);
}

const entry = Object.fromEntries(
  Object.entries(relativeEntries).map(([name, path]) => [name, resolve(packageDirectory, path)]),
);

export default defineConfig({
  entry,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outDir: resolve(packageDirectory, "dist"),
  tsconfig: resolve(packageDirectory, "tsconfig.json"),
  clean: true,
  treeshake: true,
  sourcemap: true,
  dts: {
    sourcemap: true,
  },
  deps: {
    neverBundle: [/^@lume\//],
  },
  failOnWarn: true,
});
