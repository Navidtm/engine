# Transport overhead benchmark

This browser harness compares the legacy structured-clone transform command
path with the hardened SharedArrayBuffer path at 10k, 100k, 500k, and 1M
updates. It measures producer update time, worker round-trip time, worker-side
preparation, cross-thread memory copies, and estimated transport allocations.

The page requires cross-origin isolation, exposes raw data at
`window.__LUME_TRANSPORT_RESULT__`, and does not draw comparative conclusions.
It is a worker-transport harness, not a full engine/WASM/WebGPU benchmark;
record browser version, hardware, percentile samples, missed-frame rate, and
peak heap alongside every captured report.

Run `pnpm benchmark:transport` for the reproducible Node transport, structural
ring, lifecycle, and old-versus-new suite. It writes
`benchmarks/results/transport-hardening-latest.json`. Node measurements isolate
transport CPU cost; browser results remain the source for worker scheduling and
round-trip latency.
