export interface PipelineCache {
  getOrCreate(key: string, create: () => Promise<GPURenderPipeline>): Promise<GPURenderPipeline>;
  clear(): void;
}

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
