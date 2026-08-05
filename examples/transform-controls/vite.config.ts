import { defineConfig } from "vite";

export default defineConfig({ server: { headers: headers() }, preview: { headers: headers() } });
function headers(): Record<string, string> {
  return {
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}
