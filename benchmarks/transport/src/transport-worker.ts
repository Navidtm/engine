import {
  drainSharedTransforms,
  openSharedRuntimeViews,
  type SharedRuntimeViews,
} from "@lume/runtime";

interface CommandUpdate {
  readonly entity: number;
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly scale: readonly [number, number, number];
}

type Request =
  | { readonly type: "commands"; readonly id: number; readonly updates: CommandUpdate[] }
  | { readonly type: "shared"; readonly id: number; readonly buffer: SharedArrayBuffer };

let sharedViews: SharedRuntimeViews | undefined;
const scratch = new Float32Array(10);
let checksum = 0;
const consumeTransform = (
  entity: number,
  _fieldMask: number,
  values: Float32Array<ArrayBuffer>,
): void => {
  checksum += entity + (values[0] ?? 0);
};

self.onmessage = (event: MessageEvent<Request>): void => {
  const started = performance.now();
  checksum = 0;
  if (event.data.type === "commands") {
    for (const update of event.data.updates) {
      checksum += update.entity + update.position[0];
    }
  } else {
    if (sharedViews?.buffer !== event.data.buffer) {
      sharedViews = openSharedRuntimeViews(event.data.buffer);
    }
    drainSharedTransforms(sharedViews, scratch, consumeTransform);
  }
  self.postMessage({
    id: event.data.id,
    workerPreparationMs: performance.now() - started,
    checksum,
  });
};
