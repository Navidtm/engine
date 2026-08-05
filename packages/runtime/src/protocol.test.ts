import { describe, expect, it } from "vitest";

import type { WorkerToMainMessage } from "./protocol.js";
import { createWorkerRuntime } from "./worker-runtime.js";

describe("worker protocol", () => {
  it("rejects an incompatible protocol before touching browser resources", () => {
    const events: WorkerToMainMessage[] = [];
    const receive = createWorkerRuntime({
      postMessage: (message) => events.push(message),
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => undefined,
    });
    receive({
      type: "init",
      value: {
        protocolVersion: 999,
        canvas: {} as OffscreenCanvas,
        wasmUrl: "/unused.wasm",
        entityCapacity: 1,
        transformCapacity: 1,
        size: { width: 1, height: 1, devicePixelRatio: 1 },
        renderer: {},
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
  });
});
