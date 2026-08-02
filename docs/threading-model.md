# Threading model

## Responsibilities

The main thread owns authoring handles, entity recycling and both shared
producers. The runtime worker owns the sole consumers, WASM, WebGPU and the frame
loop. Rust owns canonical scene state.

```text
Main thread                         Runtime worker
-----------                         --------------
create/destroy/add/remove  ------>  structural SPSC ring
position/rotation/scale    ------>  seqlock slots + dirty SPSC ring
                                      drain structural commands
                                      stage transform dirty ranges
                                      one range ABI call
                                      systems/extraction/visibility
                                      WebGPU submission
```

No ECS object, RenderWorld object or renderer resource crosses the boundary.

## Transform synchronization

The producer makes a slot sequence odd, writes only selected floats, publishes
generation and ORs the field mask, then makes the sequence even. A dirty
compare-and-exchange enqueues the index at most once. Atomics provide the
publication ordering.

The consumer retries a read if the sequence is odd or changes. It exchanges the
published mask, releases the dirty flag, and requeues the slot if a producer
merged another mask during consumption. This closes the clear-versus-write race
without a lock. The worker drains at frame start and never blocks with
`Atomics.wait`.

## Structural synchronization

Structural records are fixed at 16 words and cover spawn, despawn, add component
and remove component. The main thread is the only producer and the worker is the
only consumer. Payload words are written first; the atomic pending increment is
the publication point. The consumer processes FIFO records before transform
ranges, ensuring creation precedes component updates.

Initialization remains a message batch because it may exceed ring capacity
before the worker begins draining. When a live ring fills, the API permanently
selects message fallback for that engine session. The worker drains older shared
records before applying the fallback message, preserving order.

## Lifecycle ordering

Destroy and reuse are published through the same ordered structural channel:

```text
despawn(index, generation N)
spawn(index, generation N+1)
```

The old handle becomes invalid synchronously on the main thread. FIFO processing
then changes Rust liveness before any command for the replacement reaches the
ECS. Both sides validate generations independently.

## Browser requirements

`SharedArrayBuffer` requires cross-origin isolation. Development and benchmark
servers emit `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. The compatibility path uses
versioned worker messages when SAB is unavailable.
