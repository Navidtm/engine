# Entity generation and structural-churn benchmark

This Node microbenchmark compares the entity identity strategies considered by
ADR 010:

- the current packed 20-bit index and 12-bit wrapping generation;
- the same packed identity with permanent slot retirement before generation
  wrap;
- a packed 16/16 split; and
- split 32-bit index/generation fields, including a BigUint64 validation probe.

It also compares the allocating structural-command decoder with the worker's
borrowed, reusable command records. The decode workload uses a production
shared-memory `add-transform` record, performs one million decodes per timing
sample, and forces each result to escape so V8 cannot discard the command
materialization. A separate 100,000-command retained probe runs after full GC
to expose the heap cost of the allocating command object and tuple arrays.

The lifecycle workload performs one million destroy/recreate operations against
a LIFO hot slot with a 256-slot pool. This models the production allocator's
concentration of repeated churn. Validation runs five million identity checks
per sample. Atomics probes compare one packed Int32 publication, two split Int32
words, and one BigUint64 word over one million store/load cycles. Five warmups
precede fifteen measured samples, and the committed result reports the median
plus the observed range. Typed-array, free-list, and SharedArrayBuffer setup is
performed before each timer starts, so the samples measure only the modeled hot
operations.

The deterministic memory section accounts for TypeScript generation arrays,
the SAB transform layout, structural record width, Rust entity width, and
representable entity capacity. It assumes a split identity consumes an existing
spare word in the 64-byte structural record, while its SAB publication requires
one additional 32-bit word per transform slot.

Run from the repository root:

```sh
pnpm benchmark:entity-generation
```

The committed Node v24.19.0 result measured a 21.27 ms allocating median versus
11.93 ms with the reused record, a 43.9% reduction. Retaining 100,000 decoded
results grew the measured heap by 28,799,088 bytes for the allocating decoder
and 3,496 bytes for the reused decoder. These Node timings and heap deltas
isolate JavaScript representation cost; they do not claim browser Atomics,
worker latency, or WASM performance equivalence.
