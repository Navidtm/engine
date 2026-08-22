import { describe, expect, it } from "vitest";

import { getLumeWasmUrl, LUME_WASM_ABI_VERSION } from "./wasm-url.js";

describe("packaged WASM URL", () => {
  it("resolves the ABI-matched artifact beside the runtime module", () => {
    const url = getLumeWasmUrl();

    expect(url.pathname).toMatch(/\/lume_core\.wasm$/);
    expect(LUME_WASM_ABI_VERSION).toBe(9);
  });
});
