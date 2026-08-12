# WASM optimization profile benchmark

This benchmark compares equivalent `lume-wasm` release artifacts built with
`opt-level = "s"` and `opt-level = "3"`. All other workspace release settings
remain fixed: fat LTO, one codegen unit, abort-on-panic, and symbol stripping.

Run from the repository root:

```sh
pnpm benchmark:wasm-profiles
```

The runner records exact commit/toolchain/runtime/hardware metadata, build
configuration, raw/gzip/Brotli sizes, raw compile/instantiate/startup samples,
WASM transform-range and complete core-frame samples, and matching native Rust
system/extraction/visibility samples. It writes the reproducible report to
`benchmarks/results/wasm-profiles-latest.json`.

Pass `--browser` to additionally run the existing renderer benchmark in Chrome
against each generated artifact:

```sh
pnpm benchmark:wasm-profiles -- --browser
```

Browser automation is optional because headless WebGPU availability depends on
the host. Failure to acquire WebGPU is reported as unsupported, and adapter
metadata is retained so software-backed results can be identified. Node or
native measurements are never relabeled as browser frame results.
When two profiles are compared, browser runs use an ABBA order to reduce
first/last-run bias and retain every raw sample in the report.

The profile artifact directories live under `target/wasm-profile-benchmark/`
and are isolated so one profile cannot reuse the other's final binary. Build
wall time is diagnostic only because incremental cache state can affect it.

The benchmark does not change the workspace default. Update `[profile.release]`
only after reviewing the committed measurements and their limitations.
