# Threading model

## Responsibilities

The browser main thread owns authoring calls, handle creation, and shared
transform writes. The runtime worker owns WebAssembly, WebGPU, the frame loop,
and all canonical scene state.

```text
Main thread                         Runtime worker
-----------                         --------------
create/destroy/add component  --->  structural command handling
position/rotation/scale writes ---> SharedArrayBuffer dirty ring
                                     drain + one WASM bulk update
                                     systems + extraction + visibility
                                     FrameGraph + WebGPU submission
```

No renderer or ECS object crosses the worker boundary.

## Synchronization protocol

The transform channel is single-producer/single-consumer. Sequentially
consistent Atomics publish queue positions and diagnostic epochs. The worker
does not block on `Atomics.wait`; it drains available updates at the beginning
of its existing animation frame.

The consumer advances the queue and clears an entity's dirty flag before its
stable read. A concurrent producer can therefore enqueue the same entity again
without losing an update. Queue entries may be redundant under a race, but the
latest complete transform is always applied.

## Structural commands

Commands are retained for operations that change storage shape or resource
lifetime:

- spawn and despawn entity;
- add or remove component;
- create material or mesh binding;
- load or release resources.

Per-frame transforms, animation outputs, and visibility results must not use
the structural channel.

## Browser requirements

SharedArrayBuffer requires a cross-origin-isolated document. Development and
benchmark Vite servers emit `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. Production hosting must emit
equivalent headers. The runtime automatically selects command fallback when
the requirement is not met.
