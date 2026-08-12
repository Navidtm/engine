import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, resolve } from "node:path";

const host = "127.0.0.1";
const serverPort = 4_197;
const debuggingPort = 9_237;
const timeoutMs = 60_000;

export async function runBrowserBenchmarks({ repositoryRoot, artifacts, commit, entities }) {
  const chrome = findChrome();
  if (chrome === undefined) {
    return {
      environment: { status: "unsupported", reason: "Chrome executable was not found." },
      profiles: {},
    };
  }

  const publicDirectory = resolve(repositoryRoot, "benchmarks/renderer/public/wasm-profiles");
  const browserDirectory = await mkdtemp(resolve(tmpdir(), "lume-wasm-profile-chrome-"));
  await mkdir(publicDirectory, { recursive: true });
  for (const artifact of artifacts) {
    await copyFile(artifact.wasmPath, resolve(publicDirectory, `${artifact.name}.wasm`));
  }

  const server = spawn(
    "pnpm",
    [
      "--filter",
      "@lume/benchmark-renderer",
      "dev",
      "--host",
      host,
      "--port",
      String(serverPort),
      "--strictPort",
    ],
    { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  const chromeProcess = spawn(
    chrome,
    [
      "--headless=new",
      "--enable-unsafe-webgpu",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-gpu-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${debuggingPort}`,
      `--user-data-dir=${browserDirectory}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let serverErrors = "";
  let chromeErrors = "";
  server.stderr.on("data", (chunk) => (serverErrors += chunk));
  chromeProcess.stderr.on("data", (chunk) => (chromeErrors += chunk));

  try {
    await waitForUrl(`http://${host}:${serverPort}`);
    await waitForUrl(`http://${host}:${debuggingPort}/json/version`);
    const profiles = Object.fromEntries(artifacts.map((artifact) => [artifact.name, []]));
    const runOrder =
      artifacts.length === 2 ? [artifacts[0], artifacts[1], artifacts[1], artifacts[0]] : artifacts;
    for (const artifact of runOrder) {
      const query = new URLSearchParams({
        count: String(entities),
        wasmUrl: `/wasm-profiles/${artifact.name}.wasm`,
        wasmProfile: artifact.name,
        commit,
      });
      if (artifact.updateRatio !== undefined) {
        query.set("updateRatio", String(artifact.updateRatio));
      }
      profiles[artifact.name].push(
        await runPage(`http://${host}:${serverPort}/?${query.toString()}`),
      );
    }
    const first = Object.values(profiles)[0]?.[0];
    return {
      environment: {
        status: "completed",
        executable: chrome,
        userAgent: first?.browser ?? "unknown",
        headless: true,
        flags: ["--headless=new", "--enable-unsafe-webgpu", "--disable-gpu-sandbox"],
        runOrder: runOrder.map((artifact) => artifact.name),
      },
      profiles,
    };
  } catch (error) {
    return {
      environment: {
        status: "unsupported",
        executable: chrome,
        reason: error instanceof Error ? error.message : String(error),
        serverErrors: tail(serverErrors),
        chromeErrors: tail(chromeErrors),
      },
      profiles: {},
    };
  } finally {
    await Promise.all([stopProcess(server), stopProcess(chromeProcess)]);
    await rm(publicDirectory, { recursive: true, force: true });
    await rm(browserDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function runPage(url) {
  const response = await fetch(
    `http://${host}:${debuggingPort}/json/new?${encodeURIComponent(url)}`,
    { method: "PUT" },
  );
  if (!response.ok) throw new Error(`Chrome could not open benchmark page (${response.status}).`);
  const target = await response.json();
  const client = createCdpClient(target.webSocketDebuggerUrl);
  const exceptions = [];
  client.on("Runtime.exceptionThrown", (event) => {
    exceptions.push(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text);
  });
  try {
    await client.ready;
    await client.send("Runtime.enable");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const evaluation = await client.send("Runtime.evaluate", {
        expression: "window.__LUME_BENCHMARK_RESULT__ ?? null",
        returnByValue: true,
        awaitPromise: true,
      });
      if (evaluation.result?.value !== null && evaluation.result?.value !== undefined) {
        return evaluation.result.value;
      }
      if (exceptions.length > 0)
        throw new Error(`Browser benchmark failed: ${exceptions.join(" | ")}`);
      await delay(100);
    }
    throw new Error(`Browser benchmark timed out after ${timeoutMs}ms.`);
  } finally {
    client.close();
    await fetch(`http://${host}:${debuggingPort}/json/close/${target.id}`, { method: "PUT" }).catch(
      () => undefined,
    );
  }
}

function createCdpClient(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const listeners = new Map();
  let nextId = 1;
  const ready = new Promise((resolveReady, rejectReady) => {
    socket.addEventListener("open", resolveReady, { once: true });
    socket.addEventListener(
      "error",
      () => rejectReady(new Error("Chrome DevTools connection failed.")),
      {
        once: true,
      },
    );
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const request = pending.get(message.id);
      if (request === undefined) return;
      pending.delete(message.id);
      if (message.error !== undefined) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
      return;
    }
    for (const listener of listeners.get(message.method) ?? []) listener(message.params);
  });
  return {
    ready,
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolveRequest, rejectRequest) => {
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, listener) {
      const methodListeners = listeners.get(method) ?? [];
      methodListeners.push(listener);
      listeners.set(method, methodListeners);
    },
    close() {
      socket.close();
    },
  };
}

async function waitForUrl(url) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The process is still starting.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ...String(process.env.PATH ?? "")
      .split(delimiter)
      .flatMap((directory) => [
        resolve(directory, "google-chrome"),
        resolve(directory, "chromium"),
      ]),
  ].filter(Boolean);
  return candidates.find((candidate) => basename(candidate).length > 0 && existsSync(candidate));
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function stopProcess(process) {
  if (process.exitCode !== null || process.signalCode !== null) return;
  const exited = new Promise((resolveExit) => process.once("exit", resolveExit));
  process.kill("SIGTERM");
  await Promise.race([exited, delay(2_000)]);
  if (process.exitCode === null && process.signalCode === null) {
    process.kill("SIGKILL");
    await exited;
  }
}

function tail(value) {
  return value.slice(-4_000);
}
