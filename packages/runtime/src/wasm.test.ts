import { afterEach, describe, expect, it, vi } from "vitest";

import { createWasmCore } from "./wasm.js";

afterEach(() => vi.restoreAllMocks());

describe("WASM loading diagnostics", () => {
  it("explains fetch and CSP failures without leaking URL credentials or queries", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("blocked")));

    await expect(
      createWasmCore("https://user:secret@example.test/core.wasm?token=secret", 1, 1),
    ).rejects.toThrow(
      "Failed to fetch Lume WASM from https://example.test/core.wasm. Check the URL, network access, and the page's CSP connect-src policy.",
    );
  });

  it("rejects successful HTML fallbacks with an actionable MIME error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<!doctype html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      ),
    );

    await expect(createWasmCore("https://example.test/core.wasm", 1, 1)).rejects.toThrow(
      "was served as 'text/html'. Configure the server to use 'application/wasm'.",
    );
  });

  it("identifies a missing deployed artifact", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 404, statusText: "Not Found" })),
    );

    await expect(createWasmCore("https://example.test/core.wasm", 1, 1)).rejects.toThrow(
      "(404 Not Found). Verify that the version-matched artifact is deployed at this URL.",
    );
  });

  it("reports expected and actual ABI versions before using other exports", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(new Uint8Array(), { headers: { "content-type": "application/wasm" } }),
        ),
    );
    vi.spyOn(WebAssembly, "instantiate").mockResolvedValue({
      instance: { exports: { lume_abi_version: () => 5 } } as unknown as WebAssembly.Instance,
      module: {} as WebAssembly.Module,
    } as never);

    await expect(createWasmCore("https://example.test/core.wasm", 1, 1)).rejects.toThrow(
      "@lume/runtime expects 9, but the artifact reports 5",
    );
  });

  it("identifies invalid binaries and the WebAssembly CSP directive", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(new Uint8Array(), { headers: { "content-type": "application/wasm" } }),
        ),
    );
    vi.spyOn(WebAssembly, "instantiate").mockRejectedValue(new WebAssembly.CompileError("blocked"));

    await expect(createWasmCore("https://example.test/core.wasm", 1, 1)).rejects.toThrow(
      "allow WebAssembly with script-src 'wasm-unsafe-eval' where required",
    );
  });
});
