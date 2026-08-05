# `@lume/renderer`

Worker-owned WebGPU renderer. It consumes extracted `RenderFrame` typed arrays,
not ECS objects. `createMeshRenderer` is primarily for runtime integration.

```ts
const renderer = await createMeshRenderer(canvas, size, instanceCapacity);
renderer.execute(frame);
renderer.dispose();
```

The caller owns the renderer lifecycle; the renderer owns the device, surface,
pipelines, buffers, and mesh registry. Do not retain GPU resources after
`dispose()`.
