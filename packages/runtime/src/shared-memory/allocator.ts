import {
  calculateSharedMemoryLayout,
  SHARED_MEMORY_MAGIC,
  SHARED_MEMORY_VERSION,
  SharedHeader,
} from "./layout.js";
import { createSharedRuntimeViews, type SharedRuntimeViews } from "./views.js";

export function supportsSharedRuntimeMemory(): boolean {
  return typeof SharedArrayBuffer !== "undefined" && globalThis.crossOriginIsolated === true;
}

export function allocateSharedRuntimeMemory(
  capacity: number,
  commandCapacity: number = capacity,
): SharedRuntimeViews {
  if (typeof SharedArrayBuffer === "undefined") {
    throw new Error("SharedArrayBuffer is unavailable in this environment.");
  }
  const layout = calculateSharedMemoryLayout(capacity, commandCapacity);
  const views = createSharedRuntimeViews(new SharedArrayBuffer(layout.byteLength), layout);
  Atomics.store(views.header, SharedHeader.Magic, SHARED_MEMORY_MAGIC);
  Atomics.store(views.header, SharedHeader.Version, SHARED_MEMORY_VERSION);
  Atomics.store(views.header, SharedHeader.Capacity, capacity);
  Atomics.store(views.header, SharedHeader.CommandCapacity, commandCapacity);
  return views;
}
