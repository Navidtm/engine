# Developer-experience comparison

Both minimal examples require six domain concepts: runtime/renderer, world or
scene, camera, geometry, material, and mesh/entity. Lume replaces constructor
and hierarchy knowledge with `createEngine`, entity IDs, and component helpers.

The maintained examples are the comparison source of truth:

- Lume: `examples/cube/src/main.ts`
- Three.js: `runThree` in `benchmarks/comparison/src/main.ts`

Line counts should be generated from those files at report time rather than
copied into this document. The meaningful qualitative distinction is ownership:
Three.js exposes mutable graph objects, while Lume exposes values and commands;
neither is reduced to a misleading single-number score.
