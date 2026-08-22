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

GPU timestamp readback is diagnostic work triggered by `getStats()`: each call
returns the latest completed value and requests at most one following-frame
sample. Because this harness polls statistics for every measured frame, it
intentionally enables repeated query resolve/copy and asynchronous mapping
overhead. Normal frames that are not followed by diagnostic polling do not pay
that readback or JavaScript-allocation cost. `allocationsPerFrame` reports only
mandatory WebGPU frame objects and does not include this opt-in diagnostic work.

The same pull also requests split CPU instrumentation for one following frame.
The report retains the latest and cumulative stage totals plus their sample
count. Normal frames use the combined WASM update path and do not execute the
additional split-stage clocks; benchmark polling intentionally opts into that
diagnostic overhead.

Add `updateRatio=0`, `0.01`, `0.1`, or `1` to mutate that fraction of instances
on each sampled frame. Each result includes raw per-frame buffer-upload bytes
and `GPUQueue.writeBuffer` call counts. From the repository root,
`pnpm benchmark:renderer-uploads` captures the complete count/update matrix and
writes `benchmarks/results/persistent-instance-upload-latest.json`.

Milestone 6 adds `capacity`, `visibleRatio`, `boundsUpdateRatio`,
`resourceUpdateRatio`, `churnRatio`, `cameraCount`, and `visibilityMode=cpu|gpu`.
`pnpm benchmark:renderer-scalability` runs the controlled 29-scenario matrix in
CPU/GPU/GPU/CPU/AUTO/AUTO order. It covers 1k through 100k objects, 1/10/50/100%
occupancy, 0/10/50/100% visibility, independent dirty domains, 1/10/100% churn,
one/two/four-camera extraction, plus empty and seeded-random scenes. The output is
`benchmarks/results/renderer-scalability-latest.json`.

GPU measurements use pull-only indirect/visible-buffer readback. The sampled
CPU count/hash and GPU count/hash are published from the same frame and every
GPU run fails the matrix if membership differs. Readback is benchmark and
diagnostic work; ordinary engine frames do not copy visibility results to CPU.
