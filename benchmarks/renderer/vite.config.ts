import { defineConfig } from "vite";

export default defineConfig({
  server: { headers: isolationHeaders() },
  preview: { headers: isolationHeaders() },
});

function isolationHeaders(): Record<string, string> {
  return {
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}
