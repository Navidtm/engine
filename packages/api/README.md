# `@lume/api`

Browser-facing functional API for creating and running a Lume engine. It hides
workers, WebGPU objects, WASM pointers, and ECS storage.

```ts
import { createEngine } from "@lume/api";

const engine = createEngine(canvas);
engine.create.mesh({ geometry: "cube", position: [0, 0, -3] });
engine.camera.position.set(0, 0, 3);
engine.camera.setPerspective({ verticalFov: Math.PI / 3, near: 0.1, far: 100 });
await engine.init();
engine.start();
```

Use `engine.create` for normal authoring. `engine.world` is the advanced API
for adding descriptors from `@lume/scene`. Call `dispose()` when the page or
view is no longer active. Every handle belongs to exactly one engine.

Every engine creates one active perspective camera automatically. Configure its
initial transform and projection with `camera`, then use `engine.camera` for
position, rotation, and projection changes. The current renderer uses this
single engine-owned camera; application code does not create or destroy it.

The common configuration is intentionally small: use
`powerPreference: "high"` or `"low"` when needed. Transport memory budgets
are advanced settings and live under `transport`:

```ts
const engine = createEngine({
  canvas,
  entityCapacity: 100_000,
  powerPreference: "high",
  transport: { transformCapacity: 20_000 }, // transform-bearing entities use indices < 20,000
});
```
