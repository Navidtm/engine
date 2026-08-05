/** Deduplicates in-flight and completed WebGPU pipeline creation by key. */
export interface PipelineCache {
  /** Returns a cached pipeline promise or invokes `create` once for a new key. */
  getOrCreate(key: string, create: () => Promise<GPURenderPipeline>): Promise<GPURenderPipeline>;
  /** Drops cached promises; existing pipeline objects remain owned by WebGPU. */
  clear(): void;
}

/** Creates an empty pipeline cache that removes rejected creation promises. */
export function createPipelineCache(): PipelineCache {
  const pipelines = new Map<string, Promise<GPURenderPipeline>>();
  const cache: PipelineCache = {
    getOrCreate(key: string, create: () => Promise<GPURenderPipeline>) {
      const cached = pipelines.get(key);
      if (cached !== undefined) return cached;
      const pending = create();
      pipelines.set(key, pending);
      void pending.catch(() => pipelines.delete(key));
      return pending;
    },
    clear() {
      pipelines.clear();
    },
  };
  return Object.freeze(cache);
}
