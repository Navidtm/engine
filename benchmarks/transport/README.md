# Transport overhead benchmark

This browser harness compares the legacy structured-clone transform command
path with the Milestone 4 SharedArrayBuffer path at 10k, 50k, 100k, and 500k
updates. It measures producer update time, worker round-trip time, worker-side
preparation, cross-thread memory copies, and estimated transport allocations.

The page requires cross-origin isolation, exposes raw data at
`window.__LUME_TRANSPORT_RESULT__`, and does not draw comparative conclusions.
