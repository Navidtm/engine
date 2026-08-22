# ADR 010: Entity Generation Exhaustion

## Status

Accepted

## Date

2026-08-22

## Context

Entity identity crosses the main-thread API, worker transport, Rust/WASM ECS,
RenderWorld, and future persistent GPU slot metadata as one packed `u32`:

```text
20-bit index | 12-bit generation
```

The index width preserves the engine's 1,048,576-slot target. The generation
detects ordinary stale references, but the previous TypeScript and Rust
allocators incremented it modulo 4,096. Because both allocators use LIFO free
lists, repeated destruction and recreation can concentrate on one slot. A
retained generation-zero handle could therefore become equal to a new live
handle after 4,096 allocations of that slot—about 68.3 seconds at one reuse per
60 Hz frame.

This is a correctness boundary, not only a theoretical integer limit. Future
persistent GPU slots in ADR 009 also depend on complete generational identity.
Resource identities remain independent under ADR 004 and are outside this
decision.

## Measured evidence

The committed benchmark is
`benchmarks/results/entity-generation-latest.json`. It ran on macOS arm64 with
Node v24.19.0 and uses five warmups plus fifteen measured samples.

The lifecycle workload performs 1,000,000 destroy/recreate cycles against a
256-slot LIFO pool, deliberately concentrating churn on the hottest slot:

| Strategy                     | Median | Range       | Retired slots |
| ---------------------------- | -----: | ----------- | ------------: |
| packed 20/12 with wrap       | 4.27ms | 4.26–4.31ms |             0 |
| packed 20/12 with retirement | 4.27ms | 4.26–4.30ms |           244 |
| split `u32` index/generation | 4.31ms | 4.26–4.35ms |             0 |

The result does not establish a speed improvement. It shows that the
once-per-destruction retirement branch is within observed Node noise for this
workload and introduces no runtime allocation.

Five million validation operations produced these Node medians:

| Representation     |   Median |
| ------------------ | -------: |
| packed 20/12 `u32` |   4.33ms |
| packed 16/16 `u32` |   4.38ms |
| split `u32`/`u32`  |   5.37ms |
| packed `BigUint64` | 133.78ms |

These are representation microbenchmarks, not browser Atomics or WASM timing
claims. They are sufficient to reject BigInt as a zero-cost migration and show
that split-number validation is not faster than the current packed path.

One million Node `SharedArrayBuffer` publication store/load cycles measured:

| Atomic publication          |  Median |
| --------------------------- | ------: |
| one packed `Int32` word     |  9.25ms |
| two split `Int32` words     | 19.43ms |
| one packed `BigUint64` word | 34.84ms |

The split probe measures the extra atomic traffic, not a complete consistency
protocol. A real split migration would still need a seqlock or equivalent rule
to prevent consumers observing an index and generation from different writes.
Browser measurements would be mandatory before such a migration.

At 1,000,000 configured transform slots, deterministic layout accounting is:

| Representation | TS generations | SAB total | Rust `Entity` | Max entities |
| -------------- | -------------: | --------: | ------------: | -----------: |
| packed 20/12   |         2.00MB |   56.07MB |            4B |    1,048,576 |
| packed 16/16   |        0.13MB* |   3.74MB* |            4B |       65,536 |
| split 32/32    |         4.00MB |   60.07MB |            8B |    1,048,576 |

`*` The 16/16 option cannot represent the requested million slots, so its
smaller total reflects clamping to 65,536 rather than an equivalent workload.
The split design can consume a currently spare structural-record word and keep
that record at 64 bytes, but it requires an additional atomic publication word
per transform slot. It would also change message identities, WASM calls,
RenderWorld entity arrays, and future GPU identity metadata.

## Options considered

### Keep wrapping 20/12 identities

Advantages:

- no code, memory, transport, or ABI change;
- preserves the million-entity capacity; and
- retains current validation cost.

Disadvantages:

- an old handle can become valid again after only 4,096 same-slot allocations;
- the worst case is realistic under the LIFO allocator; and
- it makes ADR 009 persistent-slot identity unsafe after the same window.

Rejected. A time-bounded stale-handle guarantee is too weak for a public engine
identity, especially when the failure aliases a valid entity instead of failing
closed.

### Repartition the existing `u32` to 16 index / 16 generation bits

Advantages:

- preserves one-word transport, Atomics, and Rust layout; and
- extends the same-slot window to 65,536 allocations.

Disadvantages:

- reduces maximum entity capacity from 1,048,576 to 65,536; and
- still wraps rather than providing an engine-lifetime stale guarantee.

Rejected because it breaks the renderer-scalability capacity target without
eliminating aliasing.

### Migrate to split 32-bit index and generation fields

Advantages:

- preserves the million-entity index range;
- provides over four billion generations per slot; and
- uses ordinary numeric typed arrays rather than BigInt.

Disadvantages:

- is still finite unless slots eventually retire;
- doubles Rust entity values and TypeScript generation storage;
- adds 4MB to the million-slot SAB publication layout;
- requires protocol, shared-layout, WASM ABI, RenderWorld, and future GPU slot
  identity migration; and
- adds a multiword atomic-consistency problem unless publication uses a wider
  atomic or an additional seqlock/CAS design.

Deferred. If measured production churn makes retirement-driven capacity loss a
real workload limit, this is the preferred migration direction. It must receive
new shared-memory, protocol, and WASM ABI versions plus browser Atomics, WASM,
memory, and end-to-end benchmarks.

### Pack a wider identity in `BigUint64`

Advantages:

- represents identity atomically in one 64-bit shared word where BigInt Atomics
  are available; and
- maps conceptually to a Rust `u64`.

Disadvantages:

- JavaScript arithmetic and WASM `i64` calls use BigInt;
- the measured Node validation path was over an order of magnitude slower; and
- it still carries the wider memory and ABI costs.

Rejected for the current web-facing hot path.

### Retire a slot before its 12-bit generation wraps

Advantages:

- stale handles can never alias another live entity during an engine lifetime;
- preserves the complete 20/12 protocol, SAB layout, Atomics, WASM ABI, and
  million-entity capacity;
- adds no storage or runtime allocation; and
- the measured branch cost was within benchmark noise.

Disadvantages:

- each slot permits at most 4,096 allocations and is then permanently removed
  from the engine's reusable capacity; and
- pathological churn can eventually exhaust an otherwise mostly empty engine.

Selected.

## Decision

Keep the packed 20/12 entity identity and permanently retire a slot when its
live generation-4095 entity is destroyed. Do not increment to generation zero
and do not return the retired index to the free list. The final representable
index retires before generation 4095 because that all-ones combination is the
reserved invalid sentinel.

The main-thread allocator and Rust canonical allocator apply the same rule. The
worker entity-liveness mirror does not wrap its stored generation. No protocol,
shared-memory, structural-record, or WASM ABI version changes are required
because the representation and every transmitted value are unchanged.

The bounded resource is now reuse capacity rather than stale-reference safety:

```text
maximum allocations over engine lifetime <= entity slots × 4,096
```

At one concentrated reuse per 60 Hz frame, sequentially retiring every slot
would take approximately:

| Entity slots | Time until all slots retire |
| -----------: | --------------------------: |
|            1 |                68.3 seconds |
|        4,096 |                  77.7 hours |
|      100,000 |                   79.0 days |
|    1,000,000 |                  2.16 years |

These figures are capacity-planning bounds, not expected lifetimes. Applications
with deliberate high-frequency entity churn should reuse live entities or
choose an appropriate entity capacity. Exhaustion fails through the existing
machine-readable entity-capacity error rather than aliasing a retained handle.

## Consequences

### Positive

- The stale-handle guarantee now lasts for the complete engine lifetime.
- Delayed SAB writes, worker messages, WASM calls, RenderWorld slots, and future
  GPU metadata cannot become valid again through generation wrap.
- The Milestone 6 ABI remains unchanged and compact.
- Existing memory budgets and one-word Atomics remain valid.

### Negative

- Effective reusable capacity can decline under extreme churn.
- The current public capacity snapshot reports configured slots, not the number
  of unretired slots remaining.
- Long-running churn-heavy applications may need a future remaining-reuse
  diagnostic before exhaustion becomes operationally important.

## Validation requirements

- TypeScript and Rust tests must execute the full 4,096-allocation boundary and
  prove that generation zero never returns for the retired index.
- Capacity-one tests must prove failure after the final generation is destroyed.
- Transport and resource-coordinator tests must keep entity index zero valid and
  must not independently wrap entity generations.
- The entity-generation benchmark result must remain committed with its
  environment and deterministic layout accounting.

## Future impact

A wider split identity is not forbidden. It becomes justified only with
evidence that slot retirement materially reduces usable capacity in realistic
long-running browser workloads. Such a migration is an explicit architecture
change and must version the protocol, SAB layout, and WASM ABI together.
