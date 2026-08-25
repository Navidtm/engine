# Transport overhead benchmark

This browser harness compares the legacy structured-clone transform command
path with the hardened SharedArrayBuffer path at 10k, 100k, 500k, and 1M
updates. It records ten post-warmup raw samples for producer update time, worker
round-trip time, and worker-side preparation, plus percentile summaries,
cross-thread memory copies, and estimated transport allocations. Pass the tested
commit as `?commit=<full git commit>`.

The page requires cross-origin isolation, exposes raw data at
`window.__LUME_TRANSPORT_RESULT__`, and does not draw comparative conclusions.
It is a worker-transport harness, not a full engine/WASM/WebGPU benchmark;
record browser version and hardware alongside every captured report. Frame-time
and missed-frame measurements belong to the end-to-end renderer comparison,
not this isolated throughput harness.

Run `pnpm benchmark:transport` for the reproducible Node transport, structural
ring, lifecycle, and old-versus-new suite. It writes
`benchmarks/results/transport-hardening-latest.json`. Node measurements isolate
transport CPU cost; browser results remain the source for worker scheduling and
round-trip latency.

The Node suite also runs one million production position-control writes through
entity validation and shared-memory publication. On Node v24.19.0, the retained
allocating baseline measured 73.89 ms and two explicit object/tuple literals per
write; the reusable path measured 73.50 ms with no steady-state literals. The
timing ranges overlap, so this is an allocation-discipline result rather than a
throughput claim.
