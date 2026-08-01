# Benchmarking

## Native ECS suite

Run:

```sh
pnpm benchmark
```

The release runner records raw samples for entity creation, transform insert,
iteration and query, transform-system update, render extraction, and frustum
culling. Scaling counts are 1k, 10k, 50k, 100k, 500k, and 1M entities. The
committed result includes duration, throughput, allocation counts, allocated
bytes, and estimated owned memory.

## Transport overhead suite

Run:

```sh
pnpm --filter @lume/benchmark-transport dev
```

The cross-origin-isolated browser harness compares structured-clone command
batches and shared-memory updates for 10k, 50k, 100k, and 500k transforms. It
records producer update latency, worker round-trip cost, worker preparation,
cross-thread copies, and estimated transport allocations. Raw output is exposed
as `window.__LUME_TRANSPORT_RESULT__`.

## Rendering and comparison suites

The renderer suite measures 1k, 10k, 50k, and 100k cubes. The comparison suite
uses the same indexed cube, resolution, camera, warmup, and sample counts for
Lume and pinned Three.js. GPU time is a real timestamp-query result or `null`.

Browser reports must be captured on the same browser session and hardware.
When no controlled browser is connected, the repository records `status:
"not-run"` with `rawMeasurements: null`; missing data is never replaced by an
estimate.

## Interpreting results

Native timings isolate ECS and extraction architecture. Browser timings include
worker scheduling, WebAssembly staging, WebGPU command preparation, and browser
variance. Compare raw samples within the same suite; do not compare a native
mean directly with an end-to-end browser frame.
