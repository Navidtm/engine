import type { RendererOptions, SurfaceSize } from "@lume/renderer";

/** Version checked before a main thread and worker exchange runtime messages. */
export const RUNTIME_PROTOCOL_VERSION = 5;

/** Snapshot returned by {@link Engine.getStats} through the worker boundary. */
export interface EngineStats {
  /** Time between the starts of the two most recent worker frames, in milliseconds. */
  readonly frameTime: number;
  /** CPU time spent advancing WASM and encoding the most recent frame. */
  readonly cpuTime: number;
  /** Latest asynchronous GPU timestamp duration, or `null` when unavailable. */
  readonly gpuTime: number | null;
  /** Frame-scoped WebGPU objects; reusable engine allocations are excluded. */
  readonly allocationsPerFrame: number;
  readonly render: {
    /** Number of indexed draw calls encoded in the most recent frame. */
    readonly drawCalls: number;
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
    /** CPU milliseconds spent preparing extraction/visibility work. */
    readonly framePreparationCpuTime: number;
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
  };
}

/** Compact structural command understood by the worker and Rust/WASM core. */
/** Internal structural operation encoded for the worker or shared command ring. */
export type RuntimeCommand =
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
      readonly type: "add-material";
      readonly entity: number;
      readonly color: readonly [number, number, number, number];
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
      readonly component: "transform" | "material" | "camera" | "mesh" | "bounds";
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
  /** Independent fixed capacity for synchronized transform slots. */
  readonly transformCapacity: number;
  /** Initial CSS size and pixel ratio of the render surface. */
  readonly size: SurfaceSize;
  /** Renderer configuration already validated by the authoring API. */
  readonly renderer: RendererOptions;
  /** Optional initialized transport buffer; absent for message fallback. */
  readonly sharedMemory?: SharedArrayBuffer;
}

/** Versioned messages sent from the main-thread API to the runtime worker. */
export type MainToWorkerMessage =
  | { readonly type: "init"; readonly value: RuntimeInit }
  | { readonly type: "command"; readonly value: RuntimeCommand }
  | { readonly type: "batch"; readonly value: readonly RuntimeCommand[] }
  | { readonly type: "start" }
  | { readonly type: "stop" }
  | { readonly type: "resize"; readonly value: SurfaceSize }
  | { readonly type: "get-stats"; readonly requestId: number }
  | { readonly type: "dispose" };

/** Versioned lifecycle, statistics, and error messages returned by the worker. */
export type WorkerToMainMessage =
  | { readonly type: "ready" }
  | { readonly type: "stopped" }
  | { readonly type: "disposed" }
  | { readonly type: "stats"; readonly requestId: number; readonly value: EngineStats }
  | { readonly type: "error"; readonly message: string; readonly stack?: string }
  | { readonly type: "device-lost"; readonly reason: string; readonly message: string };
