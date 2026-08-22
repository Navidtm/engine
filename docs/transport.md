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
| reuse         | fixed free list; generation-4095 slots retire instead of wrapping         |
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

The first structural-ring overflow creates a one-way ordering barrier. When
the worker receives that fallback command, it drains already-published shared
structural commands first and shared transforms second, then applies the
message command. From that point until disposal, both structural and transform
authoring updates use the worker message stream. This preserves the existing
structural-before-transform drain rule across the SAB/message boundary without
adding messages to the normal shared-memory path.

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
| partial transform SAB |   10k |   1.53 ms |  1.25 ms |
| partial transform SAB |  100k |   9.56 ms |  7.94 ms |
| partial transform SAB |  500k |  46.02 ms | 40.61 ms |
| partial transform SAB |    1M | 100.65 ms | 82.97 ms |
| structural SPSC ring  |   10k |   0.88 ms |  0.59 ms |
| structural SPSC ring  |  100k |   4.32 ms |  4.02 ms |
| structural SPSC ring  |  500k |  23.99 ms | 18.45 ms |

Sequential transform runs merged into one dirty range and reported zero hot-path
allocations. At 1M position updates, estimated staging bytes fell from 40 MB of
full transform payload to 20,000,008 bytes including masks, generations and the
range descriptor. Lifecycle create/destroy/reuse at 1M measured 9.82/4.76/1.00
ms in the typed-array model.

Shared-memory version 4 adds an atomic generation/mask claim and post-claim
sequence verification. Compared with the prior unguarded drain, the 1M Node
drain rose from 67.26 ms to 82.97 ms. This is an explicit correctness cost: the
old result could lose a same-field concurrent write or merge fields across a
recycled generation.

These numbers isolate transport CPU work in Node and are not browser frame-time
or latency claims. They do not exercise browser worker scheduling, structured
clone, a real WASM core, or WebGPU submission. The browser harness is only a
collection tool until controlled Chrome and Edge reports are committed for the
same hardware, browser versions, scene scale, percentile distribution,
missed-frame rate, and peak heap. Raw Node results are in
`benchmarks/results/transport-hardening-latest.json`.

## Remaining bottlenecks

1. Every published entity still pays Atomics and a seqlock read.
2. SAB-to-WASM copying remains necessary under exclusive Rust ownership.
3. Fragmented producer order creates more ranges; the runtime does not sort.
4. Each entity slot has at most 4,096 lifetime allocations before permanent retirement;
   exhaustion fails closed instead of wrapping a stale identity.
5. Browser scheduling and worker WebGPU support remain platform-dependent.

The transport correctness contract is complete, but its latency budget is
unproven at browser level. Renderer scalability work may proceed in parallel;
transport performance claims require the controlled browser evidence above.
