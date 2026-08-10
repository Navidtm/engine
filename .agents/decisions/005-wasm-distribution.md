# ADR 005: Package-Owned Raw WASM Distribution

## Status

Accepted

## Date

2026-08-10

# Context

The public API previously defaulted to `/lume_core.wasm`, while the repository
build copied the binary into each example and benchmark `public` directory.
That convention is not a package contract: npm consumers would need to discover
and manually copy an undocumented file, root-relative URLs fail under subpath
deployments, and a separately deployed binary can silently drift from the
TypeScript runtime package that consumes its ABI.

The runtime intentionally uses a dependency-free C ABI and direct
`WebAssembly.instantiate`. Generated JavaScript glue is not needed and must not
be introduced merely to distribute the binary.

# Decision

`@lume/runtime` owns and publishes `lume_core.wasm` beside its compiled ESM
files. Its opt-in `@lume/runtime/wasm-url` entry point exports:

- `getLumeWasmUrl()`, which returns
  `new URL("./lume_core.wasm", import.meta.url)`; and
- `LUME_WASM_ABI_VERSION`, the ABI expected by that runtime package.

`@lume/api` uses this package-owned URL when `EngineConfig.wasmUrl` is omitted.
Applications normally configure no WASM path:

```ts
const engine = createEngine({ canvas });
```

The static module-relative URL has two supported interpretations:

1. Asset-aware bundlers such as Vite fingerprint and emit the adjacent binary.
2. Native ESM servers serve the binary beside the runtime JavaScript.

The helper is a separate entry point so transport-only consumers of the main
runtime module do not cause asset-aware bundlers to emit an unused WASM binary.

The existing `wasmUrl: string | URL` option remains the explicit escape hatch
for CDN and self-hosted deployments. String overrides are resolved against
`document.baseURI`, so relative values honor application subpaths and HTML
`<base>` configuration. URL objects are used as provided. The application is
responsible for deploying a binary copied from the same `@lume/runtime` package.

The raw WASM export `lume_abi_version()` is checked before any other ABI export
is used. A mismatch reports expected and actual versions and instructs the
consumer to use the artifact shipped with the same runtime version. Packaging
integration tests instantiate the packed binary and compare it with the
exported TypeScript ABI constant.

# Build and publish contract

The release WASM build copies exactly one artifact into
`packages/runtime/dist/lume_core.wasm`. Package `files` includes `dist`, and the
runtime `prepack` lifecycle rebuilds both the Rust artifact and TypeScript
output. Publishing or packing `@lume/runtime` therefore cannot omit the binary
when the required Rust target is installed.

Repository examples and benchmarks consume the package default. They do not
own copies of the binary and do not use root-relative URLs.

CI validates:

- the release WASM build;
- packed renderer, scene, runtime, and API packages;
- installation into an isolated consumer;
- direct native ESM resolution and ABI instantiation; and
- Vite emission of a fingerprinted `.wasm` asset.

# Failure contract

Initialization errors identify the failed stage and provide an action:

- fetch/network/CSP `connect-src` failures identify the sanitized URL;
- non-success HTTP responses request verification of deployed package assets;
- HTML fallbacks and other incorrect MIME types request `application/wasm`;
- compilation failures mention corruption and CSP `script-src 'wasm-unsafe-eval'`;
  and
- ABI failures report expected and actual versions.

Credentials, query strings, and fragments are removed from URLs included in
diagnostics.

# Alternatives Considered

## Require every caller to provide a URL

Rejected as the default. It is explicit but makes the common installation path
fragile and forces every consumer to understand package internals. The override
remains available for deployments that need it.

## Keep a root-relative `/lume_core.wasm` default

Rejected. It assumes a deployment root, does not support hashed assets, and has
no package-version relationship.

## Inline the binary as base64 or a data URL

Rejected. It increases JavaScript parse/download cost, prevents independent
caching, and duplicates the binary when multiple chunks reference it.

## Adopt `wasm-pack` generated glue

Rejected. The existing raw ABI is intentional, stable, and allocation-aware.
Generated bindings would add a second boundary and distribution model without
solving an engine requirement.

## Default to a project-owned CDN URL

Rejected. It introduces a network and availability dependency, complicates CSP
and offline use, and can decouple npm and WASM versions. Applications may opt
into their own CDN through `wasmUrl`.

# Consequences

## Positive

- Normal package consumers do not manually copy or configure WASM.
- Vite supports hashed assets and subpath deployments automatically.
- Native ESM and self-hosted deployments have a documented layout.
- Runtime and binary ABI mismatch is detected before unsafe ABI use.
- The raw, glue-free WASM boundary remains unchanged.

## Negative

- Publishing `@lume/runtime` requires Rust and the
  `wasm32-unknown-unknown` target.
- Bundlers must support the standard static `new URL(..., import.meta.url)`
  asset pattern or consumers must set `wasmUrl`.
- Strict servers must be configured to serve `.wasm` as `application/wasm`.

# Performance and memory impact

URL creation, fetch validation, and ABI validation occur once during
initialization. No frame-loop allocation, WASM boundary call, or rendering data
flow changes. The binary remains an independently cacheable asset and no
generated glue is added.

# Future Impact

Release automation must run the runtime package lifecycle and must not publish
TypeScript output without its adjacent binary. Any ABI change updates Rust's
`ABI_VERSION` and `LUME_WASM_ABI_VERSION` in the same change and must pass the
packaged-consumer test.
