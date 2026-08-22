/** Private renderer-side residency mirror for color-only material keys. */
export interface MaterialRegistry {
  register(handle: number): void;
  remove(handle: number): boolean;
  has(handle: number): boolean;
  dispose(): void;
}

/** Creates a fixed-capacity generational material registry with private slots. */
export function createMaterialRegistry(capacity: number): MaterialRegistry {
  const generations = new Uint16Array(capacity);
  const occupied = new Uint8Array(capacity);
  let disposed = false;
  return {
    register(handle) {
      if (disposed) throw new Error("Cannot register material after renderer disposal.");
      const index = handle & 0x000f_ffff;
      const generation = handle >>> 20;
      if (
        index <= 0 ||
        index >= capacity ||
        occupied[index] !== 0 ||
        generations[index] !== generation
      ) {
        throw new Error(`Invalid or occupied material handle: ${handle}`);
      }
      generations[index] = generation;
      occupied[index] = 1;
    },
    remove(handle) {
      const index = handle & 0x000f_ffff;
      if (
        index <= 0 ||
        index >= capacity ||
        occupied[index] === 0 ||
        generations[index] !== handle >>> 20
      ) {
        return false;
      }
      occupied[index] = 0;
      generations[index] = (generations[index] + 1) & 0x0fff;
      return true;
    },
    has(handle) {
      const index = handle & 0x000f_ffff;
      return occupied[index] !== 0 && generations[index] === handle >>> 20;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      occupied.fill(0);
    },
  };
}
