# Lume examples

Every example is a standalone Vite application. Run one with
`pnpm --filter <package-name> dev`; its `predev` hook builds the current packages
and their version-matched WASM asset. Vite serves that package-owned binary
without a per-example `public` copy. The dev server supplies the
cross-origin-isolation headers required for the shared-memory transport.

| Example            | Command                                              | What it demonstrates                                                             |
| ------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| Triangle           | `pnpm --filter @lume/example-triangle dev`           | Smallest engine setup and a single built-in mesh.                                |
| Cube               | `pnpm --filter @lume/example-cube dev`               | Material, camera, indexed cube, stats, and error handling.                       |
| Instancing         | `pnpm --filter @lume/example-instancing dev`         | 256 independent mesh entities sharing one material.                              |
| Transform controls | `pnpm --filter @lume/example-transform-controls dev` | Position-only shared transform updates from a UI control.                        |
| Entity lifecycle   | `pnpm --filter @lume/example-lifecycle dev`          | Destroy/recreate flow, generation changes, and safe slot recycling.              |
| Camera controls    | `pnpm --filter @lume/example-camera dev`             | The engine camera's position, yaw quaternion, field of view, and clipping setup. |
| Geometry loading   | `pnpm --filter @lume/example-geometry-loading dev`   | Public GLB loading, worker decode, typed errors, and asset accounting.           |

For a complete production setup, serve over HTTPS with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`; otherwise Lume transparently uses its worker-message fallback.
