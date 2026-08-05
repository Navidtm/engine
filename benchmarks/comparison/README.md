# Three.js comparison harness

The comparison harness renders the same indexed unit-cube layout, perspective
camera, 1280×720 resolution, warmup, and sample count with Lume or Three.js.
Three.js is pinned to 0.185.1 so saved results remain reproducible.

Query parameters:

- `implementation=lume|three`
- `count=<positive integer>`
- `updateRatio=0|0.01|0.1|1`
- `commit=<full git commit>`

The update ratio controls how many leading instances are updated per frame;
zero is the static scenario. Each page exposes its raw JSON as
`window.__LUME_COMPARISON_RESULT__`. Dynamic Lume results intentionally include
the current public command transport; internal transform-only performance is
reported separately by the zero-allocation Rust benchmark. This avoids hiding a
known architectural cost.

Capture both implementations at 1k, 10k, 50k, and 100k objects and all four
update ratios in the same browser session. Reports include raw frame samples,
p50/p95/p99/max summaries, missed-frame counts, browser/GPU metadata, and the
tested commit. Store the returned objects without post-processing so the
repository contains raw measurements rather than a performance conclusion.
