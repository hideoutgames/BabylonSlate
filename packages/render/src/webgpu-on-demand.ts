import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { CreateEngineOptions } from "./create-engine";

/**
 * The always-loaded side of the WebGPU code. Babylon's WebGPU engine, its
 * pipeline and bind-group caches and the WGSL shaders Haptic registers load on
 * demand, with `webgpu-engine.ts`, the first time a WebGPU Engine is created;
 * a WebGL2 session never fetches them (the player keeps them in
 * `player-webgpu.js`). Code that runs for both backends imports none of them:
 * it reads what it needs from here, which that code fills when it loads.
 */

/** Throws when this browser has no WebGPU. */
export function assertWebGpuAvailable(): void {
  if (typeof navigator === "undefined" || !("gpu" in navigator) || !navigator.gpu)
    throw new Error("WebGPU is unavailable in this browser.");
}

/**
 * The on-demand WebGPU code; loading it registers its WGSL shaders and engine extensions. A browser without WebGPU
 * rejects before the fetch, so a WebGL2-only device never downloads it, even for a project that asks for WebGPU.
 */
export async function loadWebGpuEngineModule(): Promise<typeof import("./webgpu-engine")> {
  assertWebGpuAvailable();
  return import("./webgpu-engine");
}

/** A fully initialized WebGPU project Engine (`webgpu-engine.ts`), after loading the WebGPU code. */
export async function createAppWebGpuEngine(
  canvas: HTMLCanvasElement,
  options?: Pick<CreateEngineOptions, "ktx2BasePath" | "dracoBasePath" | "meshoptBasePath">,
  signal?: AbortSignal,
): Promise<WebGPUEngine> {
  const webgpu = await loadWebGpuEngineModule();
  signal?.throwIfAborted();
  return webgpu.createAppWebGpuEngine(canvas, options, signal);
}

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

export type WebGpuCacheCounts = { bindGroups: number; pipelines: number };

const cachePruners = new WeakMap<object, () => WebGpuCacheCounts>();

/** `pruneReleasedWebGpuCacheEntries` registers each WebGPU Engine's pruner here. */
export function registerWebGpuCachePruner(engine: object, prune: () => WebGpuCacheCounts): void {
  cachePruners.set(engine, prune);
}

/** Prune everything `engine` released so far now (an idle drain); nothing for other Engines. */
export function pruneWebGpuCachesNow(engine: object): WebGpuCacheCounts | null {
  return cachePruners.get(engine)?.() ?? null;
}
