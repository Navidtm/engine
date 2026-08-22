import type { EngineStats, RuntimeCommand, SharedRuntimeViews } from "@lume/runtime";

import type { ResourceState } from "../resource-lifecycle.js";
import type { EngineConfig, EngineStatus } from "./types.js";

/** Mutable state explicitly owned by one public engine facade. */
export interface EngineState {
  readonly config: EngineConfig;
  readonly worker: Worker;
  readonly pendingCommands: RuntimeCommand[];
  readonly sharedMemory: SharedRuntimeViews | undefined;
  status: EngineStatus;
  readonly entityCapacity: number;
  readonly transformCapacity: number;
  readonly entityGenerations: Uint16Array;
  readonly entityAlive: Uint8Array;
  readonly freeEntities: Uint32Array;
  readonly resources: ResourceState;
  nextEntityIndex: number;
  freeEntityCount: number;
  initPromise: Promise<void> | undefined;
  resolveInit: (() => void) | undefined;
  rejectInit: ((error: Error) => void) | undefined;
  resizeObserver: ResizeObserver | undefined;
  readonly statsRequests: Map<
    number,
    {
      readonly resolve: (stats: EngineStats) => void;
      readonly reject: (error: Error) => void;
    }
  >;
  nextStatsRequest: number;
  structuralFallback: boolean;
  /** Monotonic control request used to reject stale worker acknowledgements. */
  lifecycleEpoch: number;
  /** Latest desired scheduling state, including an in-flight stop or restart. */
  runningIntent: boolean;
}
