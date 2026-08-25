# @lume/assets

Pure, renderer-independent asset validation and decoding for Lume.

Milestone 7 initially supports one constrained, indexed static geometry from a
GLB 2.0 container. The package does not fetch URLs, create ECS entities, or own
WebGPU resources.

```ts
import { decodeGlbGeometry, defineGeometryDecodeLimits } from "@lume/assets";

const limits = defineGeometryDecodeLimits({
  maxEncodedBytes: 16 * 1024 * 1024,
  maxDecodedBytes: 64 * 1024 * 1024,
  maxVertices: 1_000_000,
  maxIndices: 3_000_000,
});

const geometry = decodeGlbGeometry(glbArrayBuffer, limits);
```

The values above are illustrative, not engine defaults. Production defaults
remain gated on the committed Milestone 7 fixture measurements.
