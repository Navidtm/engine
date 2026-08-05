import type { RendererOptions, SurfaceSize } from "@lume/renderer";

export const RUNTIME_PROTOCOL_VERSION = 5;

export interface EngineStats {
  readonly frameTime: number;
  readonly cpuTime: number;
  readonly gpuTime: number | null;
  /** Frame-scoped WebGPU objects; reusable engine allocations are excluded. */
  readonly allocationsPerFrame: number;
  readonly render: {
    readonly drawCalls: number;
    readonly visibleObjects: number;
    readonly extractedObjects: number;
  };
  readonly memory: {
    readonly gpuBuffers: number;
    readonly wasmHeap: number;
    readonly jsHeap: number | null;
  };
  readonly timings: {
    readonly bufferUploadCpuTime: number;
    readonly framePreparationCpuTime: number;
  };
  readonly transport: {
    readonly kind: "shared-memory" | "commands";
    readonly messages: number;
    readonly sharedWrites: number;
    readonly dirtyRanges: number;
    readonly bytesUploaded: number;
    readonly queueDepth: number;
    readonly droppedCommands: number;
  };
}

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

export interface RuntimeInit {
  readonly protocolVersion: number;
  readonly canvas: OffscreenCanvas;
  readonly wasmUrl: string;
  readonly entityCapacity: number;
  readonly size: SurfaceSize;
  readonly renderer: RendererOptions;
  readonly sharedMemory?: SharedArrayBuffer;
}

export type MainToWorkerMessage =
  | { readonly type: "init"; readonly value: RuntimeInit }
  | { readonly type: "command"; readonly value: RuntimeCommand }
  | { readonly type: "batch"; readonly value: readonly RuntimeCommand[] }
  | { readonly type: "start" }
  | { readonly type: "stop" }
  | { readonly type: "resize"; readonly value: SurfaceSize }
  | { readonly type: "get-stats"; readonly requestId: number }
  | { readonly type: "dispose" };

export type WorkerToMainMessage =
  | { readonly type: "ready" }
  | { readonly type: "stopped" }
  | { readonly type: "disposed" }
  | { readonly type: "stats"; readonly requestId: number; readonly value: EngineStats }
  | { readonly type: "error"; readonly message: string; readonly stack?: string }
  | { readonly type: "device-lost"; readonly reason: string; readonly message: string };
