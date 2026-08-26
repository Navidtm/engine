import { afterEach, describe, expect, it, vi } from "vitest";

import { allocateSharedRuntimeMemory } from "./shared-memory/allocator.js";
import { TransformField } from "./shared-memory/layout.js";
import { writeSharedTransform } from "./shared-memory/synchronization.js";
import { createWasmCore } from "./wasm.js";
import { LUME_WASM_ABI_VERSION } from "./wasm-abi.js";

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
      "@lume/runtime expects 11, but the artifact reports 5",
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

describe("WASM memory views", () => {
  it("refreshes memory views and accepts stale transform updates skipped by WASM", async () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 3 });
    const applied: Array<{
      readonly rangeCount: number;
      readonly generation: number;
      readonly position: number[];
      readonly mask: number;
      readonly rangeStart: number;
      readonly rangeLength: number;
    }> = [];
    const exports = new Proxy<Record<string, unknown>>(
      {
        memory,
        lume_abi_version: () => LUME_WASM_ABI_VERSION,
        lume_engine_create: () => 1,
        lume_visible_capacity: () => 1,
        lume_render_entity_capacity: () => 2,
        lume_render_camera_capacity: () => 1,
        lume_transform_update_capacity: () => 2,
        lume_transform_update_generations_ptr: () => 0,
        lume_transform_update_values_ptr: () => 16,
        lume_transform_update_masks_ptr: () => 96,
        lume_transform_range_starts_ptr: () => 112,
        lume_transform_range_counts_ptr: () => 120,
        lume_engine_spawn: () => {
          memory.grow(1);
          return 1;
        },
        lume_engine_update: () => {
          memory.grow(1);
          return 1;
        },
        lume_engine_apply_transform_ranges: (_handle: number, rangeCount: number) => {
          applied.push({
            rangeCount,
            generation: new Uint32Array(memory.buffer, 0, 2)[0] ?? 0,
            position: [...new Float32Array(memory.buffer, 16, 20).slice(0, 3)],
            mask: new Uint32Array(memory.buffer, 96, 2)[0] ?? 0,
            rangeStart: new Uint32Array(memory.buffer, 112, 2)[0] ?? 0,
            rangeLength: new Uint32Array(memory.buffer, 120, 2)[0] ?? 0,
          });
          return 0;
        },
      },
      {
        get(target, property) {
          if (property in target) return Reflect.get(target, property);
          if (typeof property === "string" && property.endsWith("_ptr")) return () => 256;
          return () => 1;
        },
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array(), {
          headers: { "content-type": "application/wasm" },
        }),
      ),
    );
    vi.spyOn(WebAssembly, "instantiate").mockResolvedValue({
      instance: { exports } as unknown as WebAssembly.Instance,
      module: {} as WebAssembly.Module,
    } as never);
    const shared = allocateSharedRuntimeMemory(2);
    const core = await createWasmCore("https://example.test/core.wasm", 2, 2, shared.buffer);

    core.apply({ type: "spawn", entity: 0 }, 1);
    writeSharedTransform(
      shared,
      0,
      {
        position: [4, 5, 6],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
      TransformField.Position,
    );
    core.updateSharedTransforms();

    expect(applied).toEqual([
      {
        rangeCount: 1,
        generation: 0,
        position: [4, 5, 6],
        mask: TransformField.Position,
        rangeStart: 0,
        rangeLength: 1,
      },
    ]);
    expect(core.stats().sharedTransformUpdates).toBe(0);
    expect(core.update().instanceData.buffer).toBe(memory.buffer);
  });
});
