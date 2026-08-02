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
The renderer retains the `GPUDevice`; only its device-loss promise is exposed to
the worker lifecycle. Initialization waits for both renderer and WASM branches
to settle, then disposes every fulfilled branch if either failed.

## Transform synchronization

The producer makes a slot sequence odd, writes only selected floats, and updates
one atomic publication word containing generation plus field mask before making
the sequence even. Masks merge only while the generation matches; a recycled
generation replaces the old mask. A dirty compare-and-exchange enqueues the
index at most once.

The consumer reads a stable value snapshot, atomically claims the matching
generation/mask word, and checks the sequence again. If an idempotent producer
write changed the sequence without changing the mask bits, the consumer restores
the claimed bits and retries. After releasing the dirty flag it requeues any
publication that arrived during consumption. The worker drains at frame start
and never blocks with `Atomics.wait`.

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
ECS. Both sides validate generations independently. A transform publication
from the old generation is rejected by Rust; if the replacement publishes
before drain, its generation atomically replaces the old publication mask.

## Browser requirements

`SharedArrayBuffer` requires cross-origin isolation. Development and benchmark
servers emit `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. The compatibility path uses
versioned worker messages when SAB is unavailable.
