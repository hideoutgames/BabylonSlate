import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";

/**
 * Stock WGSL text the WebGPU code registered (`webgpu-registrations.ts`), by its Babylon store name, for an adapter that
 * rewrites it. Only WebGPU paths ask, and a WebGPU Engine exists only once that code has loaded.
 */
export function registeredWgsl(name: string, store: "shader" | "include"): string {
  const source = (store === "shader" ? ShaderStore.ShadersStoreWGSL : ShaderStore.IncludesShadersStoreWGSL)[name];
  if (typeof source !== "string")
    throw new Error(`WGSL ${store} ${name} is not registered: the WebGPU code (webgpu-registrations) has not loaded.`);
  return source;
}

/** Babylon 9.29 `WebGPUCacheRenderPipeline` statistics, which a pipeline creation updates. */
export type WebGpuPipelineStatistics = { NumCacheMiss: number; _NumPipelineCreationCurrentFrame: number };

let pipelineStatistics: WebGpuPipelineStatistics | undefined;

/** Called once by the WebGPU code as it loads (`webgpu-registrations.ts`). */
export function provideWebGpuPipelineStatistics(statistics: WebGpuPipelineStatistics): void {
  pipelineStatistics = statistics;
}

/** The pipeline-cache statistics; undefined until the WebGPU code has loaded, so before any WebGPU Engine exists. */
export function webGpuPipelineStatistics(): WebGpuPipelineStatistics | undefined {
  return pipelineStatistics;
}

/** Render pipelines every WebGPU Engine has created so far; always 0 while no WebGPU code has loaded. */
export function webGpuPipelineCacheMisses(): number {
  return pipelineStatistics?.NumCacheMiss ?? 0;
}
