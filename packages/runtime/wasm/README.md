# `lume-wasm`

Raw, dependency-free WASM ABI over `lume-core`. The TypeScript runtime verifies
`ABI_VERSION` before using it and owns all pointers returned by
`lume_engine_create`.

This crate is not a general browser API. Consumers should use `@lume/api` or
`@lume/runtime`; ABI functions are documented for runtime maintainers and must
preserve their explicit ownership and pointer-safety contracts.
