# Transport architecture

## Before and after

Before Milestone 5, hot transforms used a coalescing entity queue but every
update copied all ten floats into a compact WASM batch. Structural operations
used one `postMessage` command at a time, main-thread IDs were monotonic, and
transport statistics exposed implementation epochs rather than workload cost.

After Milestone 5:

| Concern       | Hardened path                                                             |
| ------------- | ------------------------------------------------------------------------- |
| transforms    | seqlock slot, field mask, dirty coalescing, index-based WASM staging      |
| batching      | adjacent indices merge into reusable dirty ranges                         |
| structure     | bounded 16-word SPSC ring with ordered message fallback                   |
| identity      | `{index, generation}` handles packed as 20+12 bits                        |
| reuse         | fixed free list with generation increment                                 |
| observability | messages, shared writes, ranges, uploaded bytes, depth, overflow attempts |

## Performance model

For `U` unique transform slots, `F` selected float values and `R` ranges, the
required staging copy is approximately:

```text
bytesUploaded = U × 8 + F × 4 + R × 8
```

A sequential position-only update therefore uses about 20 bytes per entity and
one range descriptor, versus 40 transform payload bytes on the old full update
path. The hot path performs no dynamic allocation. Structural publication is a
fixed 64-byte record and bounded atomic bookkeeping.

`engine.getStats().transport` reports:

- `messages`: main-to-worker messages received;
- `sharedWrites`: successful transform and structural publications;
- `dirtyRanges`: cumulative ranges applied;
- `bytesUploaded`: cumulative SAB-to-WASM staging bytes;
- `queueDepth`: current transform plus structural records;
- `droppedCommands`: structural ring overflow attempts handled by fallback.

## Benchmark results

The committed Node transport run on Darwin arm64, Node 24.16.0, produced:

| Scenario              | Scale |   Publish |    Drain |
| --------------------- | ----: | --------: | -------: |
| partial transform SAB |   10k |   1.48 ms |  1.11 ms |
| partial transform SAB |  100k |   9.44 ms |  7.22 ms |
| partial transform SAB |  500k |  46.77 ms | 34.85 ms |
| partial transform SAB |    1M | 103.09 ms | 67.26 ms |
| structural SPSC ring  |   10k |   0.91 ms |  0.57 ms |
| structural SPSC ring  |  100k |   4.38 ms |  3.85 ms |
| structural SPSC ring  |  500k |  33.72 ms | 18.69 ms |

Sequential transform runs merged into one dirty range and reported zero hot-path
allocations. At 1M position updates, estimated staging bytes fell from 40 MB of
full transform payload to 20,000,008 bytes including masks, generations and the
range descriptor. Lifecycle create/destroy/reuse at 1M measured 9.82/4.76/1.00
ms in the typed-array model.

These numbers isolate transport CPU work in Node and are not browser frame-time
claims. The browser harness records user agent, logical cores, worker round-trip
and preparation timing for controlled hardware runs. Raw results are in
`benchmarks/results/transport-hardening-latest.json`.

## Remaining bottlenecks

1. Every published entity still pays Atomics and a seqlock read.
2. SAB-to-WASM copying remains necessary under exclusive Rust ownership.
3. Fragmented producer order creates more ranges; the runtime does not sort.
4. The 12-bit generation protection window wraps after 4096 slot reuses.
5. Browser scheduling and worker WebGPU support remain platform-dependent.

The transport contract is now sufficient for rendering scalability work.
Further optimization should be driven by browser traces, not additional
communication architecture changes.
