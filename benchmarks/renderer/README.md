# Renderer benchmark

Build the workspace, then serve this directory with Vite. Use `?count=1000`,
`?count=10000`, `?count=50000`, or `?count=100000`. The harness warms up for 60
frames and records 180 raw samples for frame time, complete worker CPU time,
GPU time when timestamp queries are supported, buffer-upload enqueue time, and
frame preparation. Results are displayed as JSON and exposed as
`window.__LUME_BENCHMARK_RESULT__` for browser automation.

WebGPU does not expose portable memory totals. The harness reports owned GPU
buffer bytes and returns `null` for GPU time when timestamp queries are
unavailable rather than inventing estimates.
