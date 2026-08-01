# Renderer benchmark

Build the workspace, then serve this directory with Vite. Use `?count=1`,
`?count=1000`, `?count=10000`, or `?count=100000`. The harness warms up for 60
frames and records 180 raw samples for frame time, complete worker CPU time,
buffer-upload enqueue time, and frame preparation. Results are displayed as JSON
and exposed as `window.__LUME_BENCHMARK_RESULT__` for browser automation.

WebGPU does not expose portable memory totals or elapsed GPU time without
optional features. The harness reports owned GPU buffer bytes and `null` for
unavailable measurements rather than inventing estimates.
