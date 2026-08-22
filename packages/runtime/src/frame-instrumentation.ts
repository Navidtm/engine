export const FrameStage = {
  TransportApply: 0,
  Systems: 1,
  Extraction: 2,
  Visibility: 3,
  BufferUpload: 4,
  RenderPreparation: 5,
  CommandEncoding: 6,
  QueueSubmit: 7,
} as const;

export const FRAME_STAGE_COUNT = 8;

/** Fixed storage for pull-sampled worker-frame CPU timings. */
export interface FrameInstrumentation {
  readonly current: Float64Array<ArrayBuffer>;
  readonly latest: Float64Array<ArrayBuffer>;
  readonly cumulative: Float64Array<ArrayBuffer>;
  sampleCount: number;
  sampleRequested: boolean;
}

export function createFrameInstrumentation(): FrameInstrumentation {
  return {
    current: new Float64Array(FRAME_STAGE_COUNT),
    latest: new Float64Array(FRAME_STAGE_COUNT),
    cumulative: new Float64Array(FRAME_STAGE_COUNT),
    sampleCount: 0,
    sampleRequested: false,
  };
}

/** Coalesces statistics pulls into one sampled future frame. */
export function requestFrameSample(state: FrameInstrumentation): void {
  state.sampleRequested = true;
}

/** Claims a requested sample and resets only the unpublished frame scratch. */
export function beginFrameSample(state: FrameInstrumentation): boolean {
  if (!state.sampleRequested) return false;
  state.sampleRequested = false;
  state.current.fill(0);
  return true;
}

/** Records one stage without allocating a frame-time wrapper. */
export function recordFrameStage(
  state: FrameInstrumentation,
  stage: number,
  durationMs: number,
): void {
  state.current[stage] = durationMs;
}

export function completeFrameSample(state: FrameInstrumentation): void {
  state.latest.set(state.current);
  for (let stage = 0; stage < FRAME_STAGE_COUNT; stage += 1) {
    state.cumulative[stage] = (state.cumulative[stage] ?? 0) + (state.current[stage] ?? 0);
  }
  state.sampleCount += 1;
}
