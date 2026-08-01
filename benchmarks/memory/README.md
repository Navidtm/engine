# Memory benchmarks

The internal benchmark runner records allocator calls and requested bytes around
every operation. Transform and RenderWorld records also report deterministic
payload size from their ABI layouts.

Browser harnesses add JavaScript heap measurements only when the non-standard
`performance.memory` API is available. GPU memory is the sum of buffers owned by
the engine registry and fixed frame buffers; texture/driver overhead is not
estimated and is labeled unavailable rather than guessed.
