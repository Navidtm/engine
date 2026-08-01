# Three.js comparison harness

The comparison harness renders the same indexed unit-cube layout, perspective
camera, 1280×720 resolution, warmup, and sample count with Lume or Three.js.
Three.js is pinned to 0.185.1 so saved results remain reproducible.

Query parameters:

- `implementation=lume|three`
- `scenario=static|dynamic|large`
- `count=<positive integer>`

Defaults are 10k static cubes, 50k dynamic objects, and 100k large-scene
entities. Each page exposes its raw JSON as
`window.__LUME_COMPARISON_RESULT__`. Dynamic Lume results intentionally include
the current public command transport; internal transform-only performance is
reported separately by the zero-allocation Rust benchmark. This avoids hiding a
known architectural cost.

For the rendering milestone, capture both implementations at 1k, 10k, 50k,
and 100k objects in the same browser session. Store the returned objects without
post-processing so the repository contains raw measurements rather than a
performance conclusion.
