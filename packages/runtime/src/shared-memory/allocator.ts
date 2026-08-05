import {
  calculateSharedMemoryLayout,
  SHARED_MEMORY_MAGIC,
  SHARED_MEMORY_VERSION,
  SharedHeader,
} from "./layout.js";
import { createSharedRuntimeViews, type SharedRuntimeViews } from "./views.js";

/** Returns whether this page can use SharedArrayBuffer transport. */
export function supportsSharedRuntimeMemory(): boolean {
  return typeof SharedArrayBuffer !== "undefined" && globalThis.crossOriginIsolated === true;
}

/**
 * Allocates and initializes the transport SAB.
 *
 * `capacity` is the transform-slot budget; `commandCapacity` bounds structural
 * records independently. Both values are immutable for the engine lifetime.
 */
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
