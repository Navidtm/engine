import { defineConfig } from "@playwright/test";

const PORT = 4_174;

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "asset-showcase.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI === undefined ? 0 : 1,
  reporter: process.env.CI === undefined ? "list" : "github",
  webServer: {
    command: `pnpm --filter @lume/example-asset-showcase preview --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: process.env.CI === undefined,
    timeout: 30_000,
  },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: "chrome",
    headless: true,
    launchOptions: {
      args: ["--enable-unsafe-webgpu", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
    },
  },
});
