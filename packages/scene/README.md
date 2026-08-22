# `@lume/scene`

Serializable scene descriptors and resource-handle types. This package contains
no worker, WebGPU, registry slots, or mutable ECS state.

```ts
import { mesh, transform } from "@lume/scene";

engine.world.add(entity, transform({ position: [0, 0, -2] }));
engine.world.add(entity, mesh(engine.geometry.cube, materialHandle));
```

Constructors validate finite numeric values. Quaternion values must be non-zero;
linear RGBA colors must stay within `[0, 1]`. Geometry and material identities
are created by `@lume/api`; scene descriptors never manufacture registry keys.
