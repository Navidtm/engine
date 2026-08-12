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
batches and shared-memory updates for 10k, 100k, 500k, and 1M transforms. It
records ten raw post-warmup samples and p50/p95/p99/max summaries for producer
update latency, worker round-trip cost, and worker preparation, plus
cross-thread copies and estimated transport allocations. Raw output is exposed
as `window.__LUME_TRANSPORT_RESULT__`.

## WASM release profile suite

Run the reproducible Rust/WASM and Node comparison with:

```sh
pnpm benchmark:wasm-profiles
```

Add `-- --browser` to run the renderer through Chrome headless, the production
worker and SharedArrayBuffer transport, and WebGPU. Browser runs use ABBA order;
all raw samples and environment metadata are retained in
[`wasm-profiles-latest.json`](../benchmarks/results/wasm-profiles-latest.json).

The committed report compares `opt-level = "s"` with `opt-level = "3"` at
commit `5204235896fe48582547d6ae1e24d1971459ec8a`, with fat LTO, one codegen
unit, abort-on-panic, and stripping held constant. It was captured on an Apple
M4 with 16 GiB RAM, macOS 26.5.1, Rust 1.96.0, Node 24.19.0/V8 13.6, and
Chrome 151 headless using a non-fallback Apple Metal 3 adapter. The report
records `dirty: false`.

| Metric (10k entities)                       | `s`          | `3`          | `3` tradeoff             |
| ------------------------------------------- | ------------ | ------------ | ------------------------ |
| Raw WASM                                    | 54,185 B     | 56,759 B     | +2,574 B (+4.75%)        |
| gzip level 9                                | 20,610 B     | 21,738 B     | +1,128 B (+5.47%)        |
| Brotli quality 11                           | 17,187 B     | 18,010 B     | +823 B (+4.79%)          |
| Node/V8 compile median                      | 0.0802 ms    | 0.0793 ms    | no meaningful difference |
| Node/V8 compile + instantiate median        | 0.1094 ms    | 0.1080 ms    | no meaningful difference |
| WASM transform-range median                 | 0.0792 ms    | 0.0453 ms    | 42.82% faster            |
| WASM complete core-frame median             | 0.3760 ms    | 0.3254 ms    | 13.46% faster            |
| Browser per-run worker/render CPU median    | 0.54–1.20 ms | 0.41–0.43 ms | directional; high noise  |
| Browser presented-frame median (60Hz/vsync) | 16.665 ms    | 16.670 ms    | no measurable difference |

The workspace release default is therefore `opt-level = 3`. The recurring
runtime gain is worth 823 compressed bytes for an engine runtime, while startup
was indistinguishable at roughly one tenth of a millisecond. A separate size
build is not maintained: applications with an unusually strict payload budget
can override Cargo's release opt level and rerun this suite.

The presented browser frame is vsync-limited and must not be cited as a render
throughput improvement. Browser initialization has only two retained samples
per profile, and browser CPU varied materially between runs; both are recorded
as directional checks but excluded from the numerical decision. Build wall
time is also excluded because incremental cache state differs. The selected
evidence is artifact size, raw startup samples, and isolated WASM hot paths;
the same-session browser run validates the production path and direction only.

## Rendering and comparison suites

The renderer suite measures 1k, 10k, 50k, and 100k cubes. The comparison suite
uses the same indexed cube, resolution, camera, warmup, and sample counts for
Lume and pinned Three.js. GPU time is a real timestamp-query result or `null`.

Browser reports must be captured on the same browser session and hardware.
The comparison matrix covers 1k, 10k, 50k, and 100k cubes at 0%, 1%, 10%, and
100% per-frame transform update ratios for both implementations. Each report
records raw frame times, percentile summaries, missed frames, browser/GPU
metadata, and the tested commit.
When no controlled browser is connected, the repository records `status:
"not-run"` with `rawMeasurements: null`; missing data is never replaced by an
estimate.

## Interpreting results

Native timings isolate ECS and extraction architecture. Browser timings include
worker scheduling, WebAssembly staging, WebGPU command preparation, and browser
variance. Compare raw samples within the same suite; do not compare a native
mean directly with an end-to-end browser frame.
