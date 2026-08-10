import type { EngineStats, RuntimeCommand, SharedRuntimeViews } from "@lume/runtime";

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
}
