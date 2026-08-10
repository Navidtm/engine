export { LUME_WASM_ABI_VERSION } from "./wasm-abi.js";

/**
 * Returns the version-matched WASM artifact shipped beside `@lume/runtime`.
 *
 * Bundlers can fingerprint and relocate this static module-relative URL. Native
 * ESM servers can serve the artifact directly beside the runtime JavaScript.
 */
export function getLumeWasmUrl(): URL {
  return new URL("./lume_core.wasm", import.meta.url);
}
