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
commit `ed4ef2917083c5695996ab3c66c827d635ff333c`, with fat LTO, one codegen
unit, abort-on-panic, and stripping held constant. It was captured on an Apple
M4 with 16 GiB RAM, macOS 26.5.1, Rust 1.96.0, Node 24.19.0/V8 13.6, and
Chrome 151 headless using a non-fallback Apple Metal 3 adapter. The report
records `dirty: false`.

| Metric (10k entities)                       | `s`            | `3`            | `3` tradeoff             |
| ------------------------------------------- | -------------- | -------------- | ------------------------ |
| Raw WASM                                    | 54,185 B       | 56,759 B       | +2,574 B (+4.75%)        |
| gzip level 9                                | 20,610 B       | 21,738 B       | +1,128 B (+5.47%)        |
| Brotli quality 11                           | 17,187 B       | 18,010 B       | +823 B (+4.79%)          |
| Node/V8 compile median                      | 0.1759 ms      | 0.1875 ms      | +0.0117 ms (+6.63%)      |
| Node/V8 compile + instantiate median        | 0.2224 ms      | 0.2487 ms      | +0.0263 ms (+11.82%)     |
| WASM transform-range median                 | 0.0713 ms      | 0.0461 ms      | 35.40% faster            |
| WASM complete core-frame median             | 0.3813 ms      | 0.3327 ms      | 12.75% faster            |
| Browser per-run worker/render CPU median    | 0.855–0.915 ms | 0.795–0.900 ms | overlapping/noisy        |
| Browser presented-frame median (60Hz/vsync) | 16.660 ms      | 16.660 ms      | no measurable difference |

The workspace release default is therefore `opt-level = 3`. The recurring
runtime gain is worth 823 compressed bytes for an engine runtime, while cold
compile plus instantiation regressed by only 26 microseconds. A separate size
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

Run the persistent-instance upload matrix with:

```sh
pnpm benchmark:renderer-uploads
```

It uses the production worker, WASM core, and WebGPU renderer in controlled
Chrome runs at 1k, 10k, 50k, and 100k entities with 0%, 1%, 10%, and 100%
per-frame transform updates. The committed report retains raw upload bytes,
write counts, upload CPU time, complete worker/render CPU time, GPU timestamps,
and renderer/WASM memory. The `before` section links the last committed browser
run from the pre-change commit; it does not relabel a post-change run as a
baseline.

The report captured at commit `5c40b0539dabb81fcceed0fe6f80f6e8055cd2e3`
used Chrome 151 headless with a non-fallback Apple Metal 3 adapter on an Apple
M4. At 10,000 visible instances, the previous static path wrote 800,128 bytes
with two queue writes every frame. The persistent path measured:

| Per-frame transform updates | Median upload bytes | Median writes |
| --------------------------: | ------------------: | ------------: |
|                          0% |                   0 |             0 |
|                          1% |               8,000 |             1 |
|                         10% |              80,000 |             1 |
|                        100% |             800,000 |             1 |

The extra visible-slot GPU storage is 40,004 bytes at this configured capacity,
including the internal camera slot. CPU and GPU timings remain in the raw
report; they are directional because browser scheduling variance overlaps the
small upload-enqueue cost. At 100,000 entities, a 100% main-thread update loop
can span multiple independently scheduled worker frames, so individual raw
uploads range below the nominal eight-megabyte batch. The median was 5,070,720
bytes; this is retained as observed production scheduling, not normalized into
a synthetic single-frame result.

## Interpreting results

Native timings isolate ECS and extraction architecture. Browser timings include
worker scheduling, WebAssembly staging, WebGPU command preparation, and browser
variance. Compare raw samples within the same suite; do not compare a native
mean directly with an end-to-end browser frame.
