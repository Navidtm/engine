# Performance Change Workflow

## Purpose

Define the required process for any change that claims to improve:

- performance
- memory efficiency
- CPU usage
- GPU utilization
- runtime scalability
- latency

Performance changes must be evidence-driven.

A change without measurement is not considered a performance improvement.

# Step 1: Identify The Bottleneck

Before optimizing, identify:

- What is slow?
- Where is the bottleneck?
- Is the bottleneck CPU, GPU, memory, transport, or architecture?

Classify the bottleneck:

## CPU

Examples:

- system execution
- extraction
- command encoding
- JavaScript overhead

## GPU

Examples:

- shader cost
- bandwidth
- draw calls
- pipeline switching

## Memory

Examples:

- allocations
- copies
- cache misses
- memory growth

## Transport

Examples:

- worker communication
- WASM boundary overhead
- synchronization cost

Do not optimize without identifying the bottleneck.

# Step 2: Capture Baseline

Before changing code, record current measurements.

Required:

- benchmark name
- hardware
- browser/runtime version
- workload size
- result

Example:

```
Scenario:
100k transforms


Before:
Transform update: 0.85ms

Allocations:
0
```

Never compare against memory or assumptions.

# Step 3: Define Success Criteria

Before implementation define:

Example:

```
Goal:

Reduce transform update cost by 30%

Constraints:

- no API changes
- no memory increase
- no architecture violation
```

A performance improvement must have measurable success criteria.

# Step 4: Analyze Alternatives

Before implementation consider:

## Algorithmic Improvement

Can unnecessary work be removed?

## Data Layout Improvement

Can memory access improve?

## Batching

Can operations be grouped?

## Parallelism

Can work be moved to another thread?

## GPU Offloading

Can GPU perform this work better?

Choose the simplest solution that solves the bottleneck.

# Step 5: Implementation Rules

During implementation:

Prefer:

- simpler algorithms
- better memory layouts
- fewer copies
- batch operations
- reusable memory

Avoid:

- micro-optimizations without measurements
- unreadable code
- architecture-breaking shortcuts

# Step 6: Re-Benchmark

After implementation:

Run the same benchmark.

Record:

Before:

```
value
```

After:

```
value
```

Difference:

```
percentage change
```

Also measure side effects:

- memory usage
- binary size
- bundle size
- API impact

# Step 7: Regression Check

A faster subsystem is not automatically a better engine.

Check:

## Memory Regression

Did memory increase?

## Architecture Regression

Did the change create coupling?

## Developer Experience Regression

Did the API become harder?

## Maintenance Regression

Did complexity increase significantly?

# Performance Rules

## Rule 1: No FPS-Only Optimization

FPS alone is insufficient.

Always consider:

- frame time
- frame stability
- CPU/GPU split
- memory behavior

## Rule 2: No Fake Benchmarks

Avoid:

- unrealistic scenes
- tiny workloads
- cherry-picked numbers
- ignoring warmup

## Rule 3: Compare Equivalent Workloads

For Three.js comparisons:

Must match:

- browser
- hardware
- resolution
- scene complexity
- camera setup
- workload

## Rule 4: Protect Zero Allocation Paths

Do not introduce allocations into:

- frame loop
- ECS systems
- extraction
- visibility
- render preparation

# Benchmark Documentation Format

Every benchmark result should include:

## Environment

```
CPU:
GPU:
Browser:
OS:
Engine version:
```

## Workload

```
Entities:
Objects:
Resolution:
Features:
```

## Results

```
Metric:
Before:
After:
Difference:
```

## Conclusion

Explain:

- why it improved
- limitations
- tradeoffs

# Performance Review Checklist

Before merging:

- [ ] Bottleneck identified
- [ ] Baseline recorded
- [ ] Success criteria defined
- [ ] Benchmark added or updated
- [ ] Results documented
- [ ] Memory impact checked
- [ ] Architecture preserved

# Final Rule

Optimization is a scientific process.

Measure first.

Change second.

Measure again.

A faster number without understanding why is not an engineering result.
