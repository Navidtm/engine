# Lume examples

Every example is a standalone Vite application. Run one with
`pnpm --filter <package-name> dev`; its `predev` hook builds the current packages
and their version-matched WASM asset. Vite serves that package-owned binary
without a per-example `public` copy. The dev server supplies the
cross-origin-isolation headers required for the shared-memory transport.

| Example            | Command                                              | What it demonstrates                                                                                               |
| ------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Triangle           | `pnpm --filter @lume/example-triangle dev`           | Smallest engine setup and a single built-in mesh.                                                                  |
| Cube               | `pnpm --filter @lume/example-cube dev`               | Material, camera, indexed cube, stats, and error handling.                                                         |
| Instancing         | `pnpm --filter @lume/example-instancing dev`         | 256 independent mesh entities sharing one material.                                                                |
| Transform controls | `pnpm --filter @lume/example-transform-controls dev` | Position-only shared transform updates from a UI control.                                                          |
| Entity lifecycle   | `pnpm --filter @lume/example-lifecycle dev`          | Destroy/recreate flow, generation changes, and safe slot recycling.                                                |
| Camera controls    | `pnpm --filter @lume/example-camera dev`             | The engine camera's position, yaw quaternion, field of view, and clipping setup.                                   |
| Geometry loading   | `pnpm --filter @lume/example-geometry-loading dev`   | Public GLB loading, worker decode, typed errors, and asset accounting.                                             |
| Asset showcase     | `pnpm --filter @lume/example-asset-showcase dev`     | Heavy generated GLB, shared resources, GPU visibility, animation, camera/lifecycle controls, and live diagnostics. |

Run `pnpm test:browser:geometry` from the workspace root for the automated
Chrome/WebGPU smoke test of the production geometry-loading build.
Run `pnpm test:browser:showcase` for the corresponding production-build smoke
test of the heavier showcase.

The showcase commits `public/assets/wave-grid.glb`, a deterministic 4.1 MiB
fixture with 90,601 vertices and 540,000 indices. It contains no third-party
content and can be regenerated with `pnpm generate:showcase-asset`. The example
loads the geometry once and shares it among three meshes, surrounds it with 72
shared built-in cubes, opts into GPU visibility/indirect drawing, updates
transforms in batches, exposes camera controls, and exercises entity
destroy/recreate while displaying pull-based asset, transport, and renderer
statistics.

For a complete production setup, serve over HTTPS with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`; otherwise Lume transparently uses its worker-message fallback.
