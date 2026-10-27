/** GPU backend choices; shading and individual effects are separate settings. */
export const GPU_BACKENDS = ["auto", "webgl2", "webgpu"] as const;
export type GpuBackend = (typeof GPU_BACKENDS)[number];

export interface RenderingPipelineSettings {
  /** Project-wide: every live viewport uses the same Engine backend. */
  gpuBackend: GpuBackend;
}

export function isGpuBackend(value: unknown): value is GpuBackend {
  return GPU_BACKENDS.includes(value as GpuBackend);
}

/** Missing or unknown values normalize to WebGL2; a legacy `renderPath` key is dropped. */
export function normalizeRenderingPipeline(
  value: unknown,
): RenderingPipelineSettings {
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    gpuBackend: isGpuBackend(source.gpuBackend) ? source.gpuBackend : "webgl2",
  };
}

export interface ResolvedRenderingPipeline {
  requested: RenderingPipelineSettings;
  effective: { gpuBackend: "webgl2" | "webgpu" };
  limits: string[];
}

/**
 * The backend the Engine runs, against the requested one. This is not a device capability probe: Engine creation
 * must still verify WebGL2 availability. An unavailable request stays authored for future support.
 */
export function resolveRenderingPipeline(
  project?: Partial<RenderingPipelineSettings>,
  backend?: { gpuBackend: "webgl2" | "webgpu"; reason?: string },
): ResolvedRenderingPipeline {
  const requested = normalizeRenderingPipeline(project);
  const limits: string[] = [];
  if (backend?.reason) limits.push(backend.reason);
  else if (!backend && requested.gpuBackend === "webgpu") {
    limits.push("WebGPU is not active; using WebGL2.");
  }
  return {
    requested,
    effective: { gpuBackend: backend?.gpuBackend ?? "webgl2" },
    limits,
  };
}
