# ECS benchmarks

Run `pnpm benchmark` from the repository root. The dependency-free Rust runner
records entity creation, Transform insertion/iteration/query, transform-system
updates, render extraction, and visibility from 1k through 1M entities. Render
extraction includes static, 1%, 10%, and 100% transform-update scenarios.
Allocation counters wrap the system allocator and are reset immediately around
each measured operation.

Results are written to `benchmarks/results/internal-latest.json` with raw timing
samples, throughput, allocation counts, allocated bytes, estimated component
storage, platform metadata, engine version, and configuration.
