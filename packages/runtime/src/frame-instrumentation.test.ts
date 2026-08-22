import { describe, expect, it } from "vitest";

import {
  beginFrameSample,
  completeFrameSample,
  createFrameInstrumentation,
  FrameStage,
  recordFrameStage,
  requestFrameSample,
} from "./frame-instrumentation.js";

describe("frame instrumentation", () => {
  it("stays disabled until a pull requests one sample", () => {
    const state = createFrameInstrumentation();
    expect(beginFrameSample(state)).toBe(false);
    requestFrameSample(state);
    expect(beginFrameSample(state)).toBe(true);
    expect(beginFrameSample(state)).toBe(false);
  });

  it("resets latest values while preserving cumulative counters", () => {
    const state = createFrameInstrumentation();
    requestFrameSample(state);
    beginFrameSample(state);
    recordFrameStage(state, FrameStage.Systems, 1.25);
    completeFrameSample(state);

    requestFrameSample(state);
    beginFrameSample(state);
    expect(state.current[FrameStage.Systems]).toBe(0);
    expect(state.latest[FrameStage.Systems]).toBe(1.25);
    expect(state.cumulative[FrameStage.Systems]).toBe(1.25);
  });

  it("tracks the latest sample, cumulative time, and completed sample count", () => {
    const state = createFrameInstrumentation();
    for (const value of [1.5, 2.25]) {
      requestFrameSample(state);
      beginFrameSample(state);
      recordFrameStage(state, FrameStage.Extraction, value);
      completeFrameSample(state);
    }

    expect(state.latest[FrameStage.Extraction]).toBe(2.25);
    expect(state.cumulative[FrameStage.Extraction]).toBe(3.75);
    expect(state.sampleCount).toBe(2);
  });
});
