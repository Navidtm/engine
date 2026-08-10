# ADR 006: Frame Scheduling and Time Coordination

## Status

Accepted; implementation pending

## Date

2026-08-11

# Context

The runtime worker currently owns a self-scheduled `requestAnimationFrame` loop.
That ownership is the correct default because WebGPU, WASM, extraction, and the
renderer already live in the worker. The current loop, however, does not define
a long-term contract for simulation time, overloaded frames, manual execution,
page visibility, input publication, framework coordination, or scheduler
capability fallback.

Animation, physics, editor tooling, deterministic tests, screenshots, replay,
and framework adapters must not each invent different time semantics. The
contract also cannot move frame ownership to the main thread, send application
callbacks across the worker boundary, or add a message allocation to every
automatic frame.

This ADR defines the target contract. It does not claim that manual stepping,
fixed simulation ticks, input transport, or scheduler fallback are implemented
yet. Those APIs must not be advertised until their protocol, runtime, and tests
exist.

# Decision

## Worker ownership

The runtime worker remains the sole owner of scheduling, simulation ticks,
render extraction, and presentation. Application and framework code may publish
state or explicit control requests, but it does not supply per-frame callbacks.

```text
main thread                         runtime worker
-----------                         --------------
authoring + input publication --->  tick-boundary input snapshot
start/stop/manual control       --->  worker-owned scheduler
                                      fixed simulation tick(s)
                                      extraction + visibility
                                      one render submission
stats request                   <-->  on-demand snapshot
```

The public default remains:

```ts
const engine = createEngine(canvas);
await engine.init();
engine.start();
```

No scheduling concepts are required for this path.

## Two execution modes

Engine configuration selects one immutable execution mode.

### Automatic mode

Automatic mode is the default. A worker-owned presentation scheduler requests
callbacks and advances a fixed-step simulation accumulator. Each presentation
callback:

1. reads a monotonic worker timestamp;
2. clamps the elapsed wall time to the configured maximum;
3. executes zero or more fixed simulation ticks, up to `maxSubsteps`;
4. records and discards excess whole-tick backlog instead of entering a spiral
   of death;
5. extracts and renders once, with the remaining accumulator fraction available
   as interpolation alpha.

The default fixed delta is `1 / 60` second. Exact default limits such as maximum
wall delta and maximum substeps are versioned configuration values and must be
documented when implemented. They must be finite, positive, and immutable after
initialization.

The first presentation after `start()` or visibility resume uses zero wall
delta. It may render the current state but cannot simulate hidden or stopped
time. Simulation therefore remains stable and bounded, while presentation may
run at 60 Hz, 120 Hz, or another browser-selected cadence.

### Manual mode

Manual mode is an advanced opt-in for deterministic tests, editors, screenshots,
replay, and offline coordination. `start()` arms the runtime but does not create
an automatic presentation loop. An explicit step request contains an integer
tick count and a render flag:

```ts
await engine.step({ ticks: 1, render: true });
await engine.step({ ticks: 10, render: false });
await engine.render(); // equivalent to zero ticks plus one render
```

The names above define the intended public semantics; their final TypeScript
shape must follow the normal API review before implementation.

Manual execution:

- advances exactly the requested number of fixed ticks;
- never reads wall-clock delta or the automatic accumulator;
- samples input once at the start of each requested tick;
- renders at most once after the requested ticks;
- resolves after commands have been submitted to WebGPU, not after a
  `queue.onSubmittedWorkDone()` stall;
- preserves a monotonic simulation tick index across multiple requests.

A request is rejected when the engine is not initialized and running, when the
mode is automatic, when the tick count is negative or exceeds the configured
per-request bound, or when another manual request is pending. Requests are
serialized; overlapping steps cannot execute concurrently.

Manual request/completion messages are explicit control-plane operations. They
are not part of automatic frame execution. A future high-frequency manual
driver must use a fixed shared scheduling mailbox and completion epoch rather
than allocate a main-thread message for every frame. Message fallback may serve
low-frequency tests and tools, but framework adapters must not build a normal
render loop around it.

## Fixed timestep and render separation

Simulation time is an integer tick index plus a configured fixed delta. Systems
receive fixed time, never presentation jitter. Rendering receives the latest
completed simulation state and an interpolation alpha in automatic mode.

This requires the future runtime core to expose simulation and render
preparation as separate phases:

```text
drain structural/input publications
  -> simulate(fixedDelta, tick)
  -> repeat while accumulator permits
  -> extract(alpha)
  -> visibility/frame graph/render
```

The renderer still consumes `RenderWorld`; it never queries ECS directly.
Interpolation data belongs to simulation/extraction storage, not GPU components
or public object graphs.

## Start, stop, and visibility guarantees

`start()` and `stop()` are idempotent at both the public API and worker layers.

- `start()` from ready or stopped enters running exactly once.
- `start()` while running performs no worker publication and creates no second
  scheduler callback.
- `stop()` while running cancels the outstanding scheduler callback, preserves
  resources and simulation state, clears wall-time accumulation, and eventually
  confirms stopped.
- `stop()` while ready or stopped is a no-op.
- stale callbacks carry a scheduler epoch and cannot advance after stop,
  restart, failure, or disposal.
- dispose permanently rejects future start and step requests.

In automatic mode, page visibility defaults to suspend-on-hidden. The main
thread publishes only visibility transitions; it does not drive frames. When
hidden, the worker cancels scheduling and preserves the logical running intent.
When visible again, it resumes with a fresh time origin and zero first delta.
There is no simulation catch-up for hidden time.

Visibility suspension is not a public stop: `engine.status` remains `running`,
and user code does not need to restart the engine. Manual mode ignores automatic
visibility suspension because execution is already explicit; a tool may choose
whether to issue a render while hidden.

An advanced `visibility: "continue"` policy may be supported for workloads that
must advance while hidden, but browsers may throttle it. It uses the worker
timer fallback, remains bounded by the same timestep limits, and must never be
the default.

## Input publication contract

Continuous input state is published into fixed-capacity shared state using the
same ownership principles as transform transport. Edge events use a bounded
SPSC ring. Neither path allocates during an automatic frame.

At the beginning of simulation tick `N`, the worker claims one coherent input
epoch. A publication completed before that claim is visible to tick `N`; a
publication racing with or following the claim is visible no earlier than tick
`N + 1`. Every system in one tick observes the same epoch.

Manual and replay workflows may attach an explicit target tick. A target older
than the current tick is rejected; a future target remains bounded in the input
ring. Overflow is observable and follows an explicit coalescing or rejection
policy per input kind; it never silently grows storage.

When `SharedArrayBuffer` is unavailable, low-frequency input may use coalesced,
versioned messages and is applied at the next tick boundary. Deterministic
replay and high-frequency framework coordination require shared input transport
or an engine-local worker source; the compatibility path must not claim the
same latency guarantees.

## Scheduler capability and fallback

During initialization the worker records its available scheduler:

1. use worker `requestAnimationFrame` and `cancelAnimationFrame` when both are
   available;
2. otherwise use a worker-owned monotonic `setTimeout` scheduler in automatic
   mode;
3. never proxy main-thread `requestAnimationFrame` callbacks across the worker
   boundary.

The timer fallback uses the same fixed-step accumulator and overload bounds. It
does not claim display synchronization and must be exposed in diagnostics. If
neither worker scheduler is available, automatic `start()` fails with an
actionable capability error; manual mode remains available when its control
transport is supported.

## Statistics and profiling

Frame execution updates preallocated numeric counters in worker state. No
per-frame stats object or worker message is created. `getStats()` remains an
on-demand snapshot and may report:

- scheduler kind and execution mode;
- simulation tick and rendered-frame counts;
- simulation steps in the latest render;
- clamped wall time, dropped backlog, and max-substep hits;
- visibility suspension count and duration;
- latest consumed input epoch and bounded-queue overflows;
- existing CPU, GPU, memory, draw, and transport metrics.

Profiling hooks are pull-based snapshots or bounded shared counters. The engine
does not invoke application callbacks before or after each worker frame. GPU
completion waits are reserved for explicit diagnostics and capture workflows,
not steady-state statistics.

# Alternatives Considered

## Main-thread `requestAnimationFrame` driving the worker

Rejected. It adds a message and scheduling dependency to every frame, couples
framework/main-thread load to rendering, and weakens worker ownership.

## Variable-delta simulation on every presentation callback

Rejected as the engine-wide simulation contract. It is simple but makes
animation, physics, replay, and tests depend on browser jitter. Presentation
cadence remains variable; simulation cadence does not.

## Always-manual execution

Rejected. It complicates the common web use case, encourages framework-owned
frame callbacks, and makes accidental per-frame messages likely.

## Unlimited catch-up after stalls or hidden pages

Rejected. It produces unbounded frame cost and long-tail latency. Bounded
substeps plus observable dropped backlog are predictable.

## Per-frame events or callbacks for input and profiling

Rejected. Callbacks cannot cross the worker boundary directly, and message-based
events would create allocation and latency in every frame.

# Consequences

## Positive

- Default usage stays simple and worker-owned.
- Simulation and manual replay have one deterministic time model.
- Hidden tabs and long stalls cannot create unbounded catch-up work.
- Input consumption has a precise tick boundary.
- Framework adapters do not become render-loop owners.
- Steady-state scheduling and profiling add no main-thread frame messages.

## Negative

- The runtime must split simulation from extraction/render preparation.
- Automatic mode needs an accumulator, interpolation state, scheduler epochs,
  and overload diagnostics.
- Deterministic high-frequency manual coordination needs shared control state.
- Timer fallback is not display-synchronized.
- Message-only compatibility cannot offer the same input/manual latency.

# Implementation and Validation Requirements

Implementation must be incremental:

1. add scheduler capability detection, epochs, and idempotent lifecycle tests;
2. split fixed simulation ticks from extraction/render submission;
3. add bounded overload accounting and visibility suspension;
4. add manual control plus deterministic tick/input tests;
5. add shared input state and bounded event transport;
6. expose bounded statistics only after counters are implemented.

Tests must cover 60/120 Hz callback sequences, first-frame zero delta, long
stalls, max-substep overflow, stop/restart races, stale callbacks, hidden/visible
transitions, exact manual tick counts, render-only requests, overlapping manual
requests, input publication races, queue overflow, scheduler fallback, failure,
and disposal.

Browser validation must report scheduler kind, callback cadence, simulation
steps, dropped time, missed-frame rate, and frame-time percentiles. Determinism
tests must compare tick-indexed state hashes across repeated manual runs. This
ADR defines a performance budget but makes no performance-improvement claim.

# Future Impact

Animation, physics, replay, editor timelines, screenshot capture, and framework
adapters must use this contract. They may publish data or request bounded manual
work, but they cannot bypass worker scheduling, introduce main-thread frame
callbacks into the runtime, or change fixed simulation time semantics.
