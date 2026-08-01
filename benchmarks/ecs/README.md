# ECS benchmarks

Run `pnpm benchmark` from the repository root. The dependency-free Rust runner
records entity creation at 1k/10k/100k and Transform insertion, dense iteration,
and sparse query at 10k/100k/1M. Allocation counters wrap the system allocator
and are reset immediately around each measured operation.

Results are written to `benchmarks/results/internal-latest.json` with raw timing
samples, throughput, allocation counts, allocated bytes, estimated component
storage, platform metadata, engine version, and configuration.
