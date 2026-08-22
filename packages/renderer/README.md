# `@lume/renderer`

Worker-owned WebGPU renderer. It consumes extracted `RenderFrame` typed arrays,
not ECS objects. `createMeshRenderer` is primarily for runtime integration.

```ts
const renderer = await createMeshRenderer(canvas, size, instanceCapacity, {
  visibilityMode: "gpu",
});
renderer.execute(frame);
renderer.dispose();
```

The caller owns the renderer lifecycle; the renderer owns the device, surface,
pipelines, buffers, and private generational geometry/material registries.
Registry slots are mutated only through the worker-facing resource boundary.
Do not retain GPU resources after `dispose()`.

The renderer supports CPU reference visibility and an explicit GPU compute path.
The GPU path validates persistent active/generational slots, compacts candidates
into per-resource-run output, and submits indexed indirect draws. `auto`
currently resolves to CPU because the committed device-specific benchmark does
not establish a portable crossover threshold. Visibility readback is requested
only by `stats()` and is not part of ordinary frame submission.
