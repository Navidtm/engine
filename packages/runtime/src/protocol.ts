import type { AssetErrorCode, AssetErrorStage, GeometryBounds } from "@lume/assets";
import type { RendererOptions, SurfaceSize } from "@lume/renderer";

import type { RuntimeGeometryLimits } from "./geometry-limits.js";

/** Version checked before a main thread and worker exchange runtime messages. */
export const RUNTIME_PROTOCOL_VERSION = 13;

/** Transfer-safe typed failure returned for one correlated geometry request. */
export interface GeometryLoadErrorPayload {
  readonly code: AssetErrorCode;
  readonly stage: AssetErrorStage;
  readonly message: string;
  readonly cause?: string;
}

/** Pull-only worker asset accounting; ordinary frames do not sample these fields. */
export interface GeometryAssetStats {
  readonly pendingLoads: number;
  readonly successfulLoads: number;
  readonly failedLoads: number;
  readonly abortedLoads: number;
  readonly fetchedEncodedBytes: number;
  readonly temporaryReservedBytes: number;
  readonly retainedDecodedBytes: number;
  readonly residentGpuBytes: number;
}

/** CPU milliseconds attributed to one pull-sampled worker frame. */
export interface FrameCpuStageTimings {
  readonly transportApply: number;
  readonly systems: number;
  readonly extraction: number;
  readonly visibility: number;
  readonly bufferUpload: number;
  readonly renderPreparation: number;
  readonly commandEncoding: number;
  readonly queueSubmit: number;
}

/** Snapshot returned by {@link Engine.getStats} through the worker boundary. */
export interface EngineStats {
  /** Time between the starts of the two most recent worker frames, in milliseconds. */
  readonly frameTime: number;
  /** CPU time spent applying transport, advancing WASM, and rendering the latest frame. */
  readonly cpuTime: number;
  /** Latest asynchronous GPU timestamp duration, or `null` when unavailable. */
  readonly gpuTime: number | null;
  /** Frame-scoped WebGPU objects; reusable engine allocations are excluded. */
  readonly allocationsPerFrame: number;
  readonly assets: GeometryAssetStats;
  readonly render: {
    /** Number of indexed draw calls encoded in the most recent frame. */
    readonly drawCalls: number;
    /** Compute dispatches encoded by GPU visibility. */
    readonly computeDispatches: number;
    /** Indexed indirect draw calls encoded in the most recent frame. */
    readonly indirectDrawCalls: number;
    /** Active visibility backend. */
    readonly visibilityBackend: "cpu" | "gpu";
    /** Latest diagnostic GPU membership count. */
    readonly gpuVisibleObjects: number | null;
    /** Latest diagnostic GPU membership hash. */
    readonly gpuVisibilityHash: number | null;
    /** CPU-oracle hash captured for the same diagnostic frame. */
    readonly cpuVisibilityHash: number | null;
    /** Number of frustum-visible instances submitted to the renderer. */
    readonly visibleObjects: number;
    /** Number of instances extracted from the ECS before culling. */
    readonly extractedObjects: number;
  };
  readonly memory: {
    /** Bytes reserved by renderer-owned GPU buffers. */
    readonly gpuBuffers: number;
    /** Current byte length of linear WASM memory. */
    readonly wasmHeap: number;
    /** Browser-reported JavaScript heap bytes, or `null` when unavailable. */
    readonly jsHeap: number | null;
  };
  readonly timings: {
    /** CPU milliseconds spent writing dynamic GPU buffers. */
    readonly bufferUploadCpuTime: number;
    /** CPU-to-GPU bytes written during the latest frame. */
    readonly bufferUploadBytes: number;
    /** GPU queue buffer writes issued during the latest frame. */
    readonly bufferWriteCount: number;
    /** CPU-to-GPU bytes split by persistent scene domain. */
    readonly uploadBytesByDomain: {
      readonly instances: number;
      readonly slotState: number;
      readonly bounds: number;
      readonly resources: number;
      readonly visibility: number;
      readonly cameras: number;
      readonly indirect: number;
    };
    /** Total CPU milliseconds spent in the renderer's latest frame execution. */
    readonly framePreparationCpuTime: number;
    /** Pull-sampled split CPU stages; ordinary frames do not run these timers. */
    readonly cpuStages: {
      /** Number of completed sampled frames accumulated since initialization. */
      readonly sampleCount: number;
      /** Durations from the most recently completed sampled frame. */
      readonly latest: FrameCpuStageTimings;
      /** Sum of all completed sampled-frame durations since initialization. */
      readonly cumulative: FrameCpuStageTimings;
    };
  };
  readonly transport: {
    /** Active transport: shared memory when isolated, otherwise worker messages. */
    readonly kind: "shared-memory" | "commands";
    /** Main-to-worker messages processed since initialization. */
    readonly messages: number;
    /** Shared-memory publications written since initialization. */
    readonly sharedWrites: number;
    /** Transform dirty ranges staged for WASM since initialization. */
    readonly dirtyRanges: number;
    /** Transform bytes copied into WASM staging since initialization. */
    readonly bytesUploaded: number;
    /** Current pending structural-command or transform queue depth. */
    readonly queueDepth: number;
    /** Structural commands rejected because the bounded ring was full. */
    readonly droppedCommands: number;
    /** Transform publications routed to fallback because the dirty ring was full. */
    readonly droppedTransforms: number;
  };
}

/** Compact structural command understood by the worker and Rust/WASM core. */
/** Internal structural operation encoded for the worker or shared command ring. */
export type RuntimeCommand =
  | {
      readonly type: "create-geometry";
      readonly handle: number;
      readonly builtin: "triangle" | "cube";
    }
  | {
      readonly type: "create-basic-material";
      readonly handle: number;
      readonly color: readonly [number, number, number, number];
    }
  | {
      readonly type: "retire-resource";
      readonly resourceKind: "geometry" | "basic-material";
      readonly handle: number;
    }
  | { readonly type: "spawn"; readonly entity: number }
  | { readonly type: "despawn"; readonly entity: number }
  | {
      readonly type: "add-transform";
      readonly entity: number;
      readonly position: readonly [number, number, number];
      readonly rotation: readonly [number, number, number, number];
      readonly scale: readonly [number, number, number];
    }
  | {
      readonly type: "add-camera";
      readonly entity: number;
      readonly verticalFov: number;
      readonly near: number;
      readonly far: number;
    }
  | {
      readonly type: "add-mesh";
      readonly entity: number;
      readonly geometry: number;
      readonly material: number;
    }
  | {
      readonly type: "add-bounds";
      readonly entity: number;
      readonly center: readonly [number, number, number];
      readonly radius: number;
    }
  | {
      readonly type: "remove-component";
      readonly entity: number;
      readonly component: "transform" | "camera" | "mesh" | "bounds";
    };

/** One-time worker initialization payload. This is runtime-internal, not a public authoring API. */
export interface RuntimeInit {
  /** Must equal [`RUNTIME_PROTOCOL_VERSION`]. */
  readonly protocolVersion: number;
  /** Canvas transferred from the main thread for worker-owned presentation. */
  readonly canvas: OffscreenCanvas;
  /** URL of the version-matched runtime WASM binary. */
  readonly wasmUrl: string;
  /** Maximum live entity count accepted by the WASM world. */
  readonly entityCapacity: number;
  /** Independent slot capacity for each typed resource registry. */
  readonly resourceCapacity: number;
  /** Independent fixed capacity for synchronized transform slots. */
  readonly transformCapacity: number;
  /** Fixed mesh-renderer component count. */
  readonly meshRendererCapacity: number;
  /** Fixed camera component count, including the engine-owned active camera. */
  readonly cameraCapacity: number;
  /** Fixed explicit-bounds component count. */
  readonly boundsCapacity: number;
  /** Initial CSS size and pixel ratio of the render surface. */
  readonly size: SurfaceSize;
  /** Renderer configuration already validated by the authoring API. */
  readonly renderer: RendererOptions;
  /** Optional initialized transport buffer; absent for message fallback. */
  readonly sharedMemory?: SharedArrayBuffer;
  /** Optional immutable budgets; external loading is unavailable when absent. */
  readonly geometryLimits?: RuntimeGeometryLimits;
}

/** Versioned messages sent from the main-thread API to the runtime worker. */
export type MainToWorkerMessage =
  | { readonly type: "init"; readonly value: RuntimeInit }
  | { readonly type: "command"; readonly value: RuntimeCommand }
  | {
      readonly type: "batch";
      readonly value: readonly RuntimeCommand[];
      /** Drains earlier shared publications before applying this atomic authoring batch. */
      readonly ordered?: boolean;
    }
  | { readonly type: "start"; readonly lifecycleEpoch: number }
  | { readonly type: "stop"; readonly lifecycleEpoch: number }
  | { readonly type: "resize"; readonly value: SurfaceSize }
  | {
      readonly type: "load-geometry";
      readonly protocolVersion: number;
      readonly requestId: number;
      /** Reserved complete generational identity; no public handle exists yet. */
      readonly handle: number;
      /** Main-thread-resolved absolute URL. */
      readonly source: string;
    }
  | {
      readonly type: "abort-geometry-load";
      readonly protocolVersion: number;
      readonly requestId: number;
      readonly handle: number;
    }
  | { readonly type: "get-stats"; readonly requestId: number }
  | { readonly type: "dispose" };

/** Versioned lifecycle, statistics, and error messages returned by the worker. */
export type WorkerToMainMessage =
  | { readonly type: "ready" }
  | { readonly type: "stopped"; readonly lifecycleEpoch: number }
  | { readonly type: "disposed" }
  | { readonly type: "stats"; readonly requestId: number; readonly value: EngineStats }
  | {
      readonly type: "geometry-ready";
      readonly protocolVersion: number;
      readonly requestId: number;
      readonly handle: number;
      readonly bounds: GeometryBounds;
    }
  | {
      readonly type: "geometry-failed";
      readonly protocolVersion: number;
      readonly requestId: number;
      readonly handle: number;
      readonly error: GeometryLoadErrorPayload;
    }
  | { readonly type: "error"; readonly message: string; readonly stack?: string }
  | { readonly type: "device-lost"; readonly reason: string; readonly message: string };
