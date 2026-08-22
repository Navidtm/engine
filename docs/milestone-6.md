# Milestone 6: Renderer Scalability

## Status vocabulary

This milestone distinguishes four kinds of statement:

- **Implemented fact:** code and regression coverage exist in the repository.
- **Accepted design:** an ADR fixes semantics, but implementation may be pending.
- **Pending implementation:** production code and its required tests do not yet
  exist.
- **Measured evidence:** a committed result records a defined workload and
  environment; it is not a general performance claim.

## Implemented starting point

[ADR 007](../.agents/decisions/007-persistent-instance-storage.md) is implemented.
`RenderWorld` and the renderer own matching fixed-capacity, entity-indexed
instance arrays. Extraction exposes coalesced changed-slot ranges, visibility
publishes stable slot indices, and static frames skip instance, visibility, and
camera uploads when their data is unchanged. The controlled Chrome result is
`benchmarks/results/persistent-instance-upload-latest.json`; issue
[#8](https://github.com/Navidtm/engine/issues/8) records the completed delivery
criteria.

[ADR 008](../.agents/decisions/008-epoch-gated-render-extraction.md) is also
implemented. A world render epoch gates retained RenderWorld snapshots, and
unchanged camera plus scene state reuses visibility. Mutated scenes deliberately
retain the full linear rebuild. Native and controlled browser samples are in
`benchmarks/results/incremental-render-world-latest.json`; issue
[#9](https://github.com/Navidtm/engine/issues/9) records the completed delivery
criteria.

CPU frustum visibility, render-key ordering, and consecutive instanced draws are
the current production path and the correctness reference for GPU-driven work.

## Completed entry gates

Renderer work may expand beyond the implemented ADR 007/008 foundation because
the following prerequisite issues are closed and their acceptance criteria are
represented by code, tests, ADRs, or committed measurements:

| Gate                             | Completion evidence                                                                                                                                                                      |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SAB/message ordering             | [#16](https://github.com/Navidtm/engine/issues/16): shared records drain before ordered fallback                                                                                         |
| Stop/restart scheduling          | [#17](https://github.com/Navidtm/engine/issues/17): lifecycle and scheduler epochs reject stale callbacks                                                                                |
| Typed resource identity          | [#18](https://github.com/Navidtm/engine/issues/18): generational ownership and retirement foundation                                                                                     |
| Persistent-slot lifecycle design | [#19](https://github.com/Navidtm/engine/issues/19): ADR 009 accepted; this closes the design gate only                                                                                   |
| Profiling integrity              | [#20](https://github.com/Navidtm/engine/issues/20) and [#21](https://github.com/Navidtm/engine/issues/21): steady-state timestamp allocation removed and split timings made pull-sampled |
| Capacity and transaction safety  | [#22](https://github.com/Navidtm/engine/issues/22): explicit component budgets and transactional high-level creation                                                                     |
| Entity generation exhaustion     | [#23](https://github.com/Navidtm/engine/issues/23): slots retire before generation wrap; ABI decision and benchmark committed                                                            |
| Composed boundary coverage       | [#24](https://github.com/Navidtm/engine/issues/24): seeded transport and lifecycle state machines are reproducible                                                                       |

This table defines renderer-entry readiness. It does not mark Milestone 6
complete and does not convert accepted ADR 009 semantics into implemented facts.

## Accepted design, pending implementation

[ADR 009](../.agents/decisions/009-active-persistent-gpu-slots.md) requires every
persistent slot that can be scanned by compute to carry explicit activity and
the complete packed generational identity. The following remain unimplemented:

1. reusable CPU slot activity/identity state and lifecycle dirty domains;
2. renderer-owned slot-state storage and bounded dirty uploads;
3. transactional publication ordering between payload, activity, visibility,
   and frame-graph consumers;
4. compute visibility with output equivalence to CPU visibility;
5. indirect command generation and indirect drawing; and
6. runtime policy selection, including retention of CPU fallback.

The implementation sequence is intentionally ordered. Active/generational state
and its correctness matrix come first. Compute visibility runs beside the CPU
oracle next. Indirect commands follow only after lifecycle and visibility
equivalence are stable.

## Completion and measurement gates

Milestone 6 is not complete until the correctness tests and benchmark matrix in
ADR 009 pass. In particular:

- removal, dependency loss, and generation replacement must never leave a slot
  visibility-eligible;
- failed extraction or capacity checks must publish no partial scene;
- CPU and GPU visibility membership must match for empty, sparse, fully visible,
  fully culled, randomized, and multi-camera scenes;
- device-loss reconstruction and disposal must cover every derived GPU buffer;
- controlled measurements must report occupancy, visibility ratio, dirtiness,
  churn, camera count, upload bytes, dispatch/draw counts, CPU/GPU time,
  missed-frame distribution, and owned memory; and
- correctness hashes or readback counts must accompany performance samples.

Facts remain sourced from current code and committed results. ADR 009 defines
the accepted target. The list above is pending work and its acceptance boundary,
not a prediction of performance.
