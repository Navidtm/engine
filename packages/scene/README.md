# `@lume/scene`

Serializable scene descriptors and built-in geometry identifiers. This package
contains no worker, WebGPU, or mutable ECS state.

```ts
import { boxGeometry, material, mesh, transform } from "@lume/scene";

engine.world.add(entity, transform({ position: [0, 0, -2] }));
engine.world.add(entity, mesh(boxGeometry(), materialEntity));
```

Constructors validate finite numeric values. Quaternion values must be non-zero;
linear RGBA colors must stay within `[0, 1]`.
