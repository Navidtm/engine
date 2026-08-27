# Asset pipeline benchmark

Run the controlled Milestone 7 browser suite with:

```sh
pnpm benchmark:assets
```

The runner deterministically generates constrained-profile Small, Medium, and
Large GLBs for both supported index widths where addressable, builds the current
packages and WASM artifact, serves the isolated benchmark page, and launches
Chrome WebGPU. It records direct decoder samples, public promise latency,
worker fetch/decode/upload timing, temporary/retained/GPU byte accounting,
cleanup, and post-load steady-state transport/upload behavior.

Generated GLBs are written temporarily beside the production benchmark build.
Their exact generator and dimensions are committed instead of storing roughly
50 MiB of opaque benchmark binaries. The latest raw result is
`benchmarks/results/asset-pipeline-latest.json`.
