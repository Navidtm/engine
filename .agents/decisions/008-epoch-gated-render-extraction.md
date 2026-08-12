# ADR 008: Epoch-Gated Render Extraction

## Status

Accepted

## Date

2026-08-12

## Context

`RenderWorld::extract` rebuilt all compact instance metadata and world-space
bounds every frame, and visibility repeated culling and grouping even when no
render-consumed ECS data or camera changed. The linear path is contiguous,
fixed-capacity, and allocation-free, but native static extraction scaled from
about 0.09 ms at 10,000 renderables to 0.91 ms at 100,000 and 9.20 ms at one
million.

The optimization must preserve the ECS -> RenderWorld -> visibility boundary,
deterministic capacity failure, entity-generation safety, and the existing
linear dynamic path. It must demonstrate an end-to-end browser gain rather than
only improve an isolated Rust loop.

## Options considered

### Keep unconditional linear rebuilds

This has the smallest state and predictable sequential access, but continues
doing work proportional to scene size on unchanged frames. Controlled browser
measurements showed that cost was material in mostly-static scenes.

### Gate the retained snapshot with a world change epoch

Canonical render mutations advance one world epoch. `RenderWorld` retains the
last successfully extracted epoch and reuses its compact metadata and bounds
when the epoch matches. Visibility is retained when both the snapshot and
camera are unchanged. Any change uses the existing full linear rebuild.

This adds constant scalar state, no per-entity metadata, and no frame-time
allocation. It optimizes the measured static case without replacing the proven
dynamic algorithm.

### Maintain per-entity incremental records and active lists

Fine-grained component dirtiness could update only changed metadata and bounds,
but requires structural dirty queues, active-slot ordering, removal compaction,
material fan-out integration, and more capacity-sized memory. Partial-update
browser results did not establish enough end-to-end benefit to justify this
complexity yet.

### Split static and dynamic RenderWorld partitions

Partitions could reduce work for author-declared static content, but introduce
classification semantics, migration costs, and public or internal policy that
the current API does not need. Transform update ratios already provide a more
direct signal for future fine-grained work.

## Decision

Use epoch-gated snapshot reuse.

`World` owns a nonzero wrapping `render_epoch`. Every successful mutation of a
transform, mesh renderer, material, or bounds record, and relevant entity
destruction, advances it. Mutable render-consumed stores remain private;
allocation-free read access and revision-publishing system mutation APIs remain
available.

`RenderWorld` stores the epoch of its last successful extraction. A matching
epoch retains entity IDs, stable slots, geometry/pipeline/material metadata,
instances, and bounds while clearing only per-frame dirty ranges and rebuilding
camera records. A different epoch executes the existing linear extraction and
only publishes the new epoch after success.

The WASM core reuses visibility when the extracted snapshot and camera records
are unchanged. It retains an explicit validity flag so a failed cull can never
make a partial result reusable. Retained visibility marks its slot mapping clean
for the current frame so the renderer does not upload it again.

## Consequences

- Static extraction becomes constant-time with respect to scene size, and
  unchanged visibility culling/grouping is skipped.
- Any render-consumed mutation still performs the complete linear rebuild. This
  deliberately avoids a second, complex dynamic representation.
- Camera-only changes rebuild camera records and visibility but do not rebuild
  instance metadata or bounds.
- The change adds only a handful of scalar epoch/validity fields. Controlled
  browser measurements reported identical WASM and GPU buffer sizes before and
  after at every tested capacity.
- World systems cannot mutate transform, mesh, material, or bounds storage
  without using an API that publishes render dirtiness.
- Epoch wrap has the same bounded stale-equality risk as other compact revision
  counters. The epoch never uses zero, and equality can be incorrect only after
  a complete counter cycle between successful extractions.

## Evidence

Chrome 151 headless on Apple M4/Metal 3 used ABBA order for baseline and
candidate artifacts in the same session. Static total worker/render CPU median
fell from 0.988 ms to 0.450 ms at 10,000 entities, 2.873 ms to 0.825 ms at
50,000, and 3.967 ms to 1.368 ms at 100,000. Those reductions are 54%, 71%, and
66%, respectively. Native static extraction retained zero allocations and fell
from 0.091 ms to 0.000008 ms at 10,000 entities; larger retained-snapshot samples
approached or fell below timer resolution. Owned WASM and GPU buffer bytes were
exactly unchanged at every tested capacity; GPU-time differences were noise.

Dynamic 50,000- and 100,000-entity browser medians at 1%, 10%, and 100% update
ratios were effectively unchanged because both variants use the linear rebuild.
The 10,000-entity sessions showed inconsistent run-to-run scheduling variance,
including candidate regressions at 1% and 10%, so they are not evidence for a
dynamic-path improvement. The raw native and browser samples are committed in
`benchmarks/results/incremental-render-world-latest.json`.

## Future work

Fine-grained incremental records or static/dynamic partitions require a new
decision only if controlled partial-update measurements show a material
end-to-end bottleneck after transport, extraction, visibility, and GPU upload
costs are considered together.
