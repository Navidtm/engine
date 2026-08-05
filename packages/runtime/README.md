# `@lume/runtime`

Worker runtime and transport primitives used by `@lume/api`. Application code
normally imports only `createDefaultWorker` indirectly through `createEngine`.

The exported shared-memory helpers are intended for runtime integration and
benchmarks: allocate once, publish with `writeSharedTransform`, and drain only
from the single worker consumer. Do not expose transport buffers as application
state or mutate them from more than one producer.
