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

The version-matched WASM binary ships with `@lume/runtime` and is resolved
automatically. Vite fingerprints and emits it without a `public` copy. Set
`wasmUrl` only when intentionally hosting that same package artifact at an
application or CDN URL.

Use `engine.create` for normal authoring. `engine.world` is the advanced API
for adding descriptors from `@lume/scene`. Call `dispose()` when the page or
view is no longer active. Every handle belongs to exactly one engine.
Built-in geometry is also available as typed handles through
`engine.geometry.cube` and `engine.geometry.triangle`. Destroying a resource
retires it: existing meshes keep their usage edge, while new references fail.

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
  resourceCapacity: 2_048,
  componentCapacities: {
    transforms: 20_000,
    meshRenderers: 15_000,
    cameras: 4,
    bounds: 10_000,
  },
  powerPreference: "high",
});
```

The resolved application-visible limits are available through
`engine.capacities`. `resourceCapacity` is the independent limit for each typed
resource registry, including materials; the two built-in geometries consume two
geometry slots but no material slots. Camera counts exclude the engine-owned
active camera, whose entity, transform, camera, and render-camera slots are
reserved internally. `transport.transformCapacity` remains a compatibility
alias for `componentCapacities.transforms`. Mesh-renderer, additional-camera,
and explicit-bounds capacities may be zero.

Capacity exhaustion throws `EngineCapacityError` synchronously with
`code === "LUME_CAPACITY_EXHAUSTED"`, plus `capacityKind` and `capacity` fields.
High-level mesh creation preflights all required slots and publishes its entity,
components, lazy default material, and commands as one transaction.

Entity handles remain stale for the complete engine lifetime. A slot supports
at most 4,096 generations and is then permanently retired instead of returning to
generation zero. Churn-heavy applications should reuse live entities or budget
enough entity slots; eventual retirement exhaustion reports the normal
machine-readable entity-capacity error.
