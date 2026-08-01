import type { RendererOptions, SurfaceSize } from "@lume/renderer";

export const RUNTIME_PROTOCOL_VERSION = 2;

export interface EngineStats {
  readonly entities: number;
  readonly renderInstances: number;
  readonly frameTimeMs: number;
  readonly cpuTimeMs: number;
  readonly gpuTimeMs: number | null;
  readonly allocationsPerFrame: number;
  readonly wasmHeapBytes: number;
  readonly jsHeapBytes: number | null;
  readonly gpuBufferBytes: number;
  readonly drawCalls: number;
  readonly bufferUploadCpuTimeMs: number;
  readonly framePreparationCpuTimeMs: number;
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
    };

export interface RuntimeInit {
  readonly protocolVersion: number;
  readonly canvas: OffscreenCanvas;
  readonly wasmUrl: string;
  readonly entityCapacity: number;
  readonly size: SurfaceSize;
  readonly renderer: RendererOptions;
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
