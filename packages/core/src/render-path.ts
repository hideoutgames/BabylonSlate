/** Public renderer choices; shading and individual effects are separate settings. */
export const RENDER_PATHS = ["auto", "forward", "clusteredForward"] as const;
export type RenderPath = (typeof RENDER_PATHS)[number];
export const GPU_BACKENDS = ["auto", "webgl2", "webgpu"] as const;
export type GpuBackend = (typeof GPU_BACKENDS)[number];

export interface RenderingPipelineSettings {
  renderPath: RenderPath;
  /** Project-wide: every live viewport uses the same Engine backend. */
  gpuBackend: GpuBackend;
}

/** Scenes and temporary view/session preferences cannot replace the project Engine. */
export type RenderPathOverrides = Partial<
  Pick<RenderingPipelineSettings, "renderPath">
>;

export function isRenderPath(value: unknown): value is RenderPath {
  return RENDER_PATHS.includes(value as RenderPath);
}

export function isGpuBackend(value: unknown): value is GpuBackend {
  return GPU_BACKENDS.includes(value as GpuBackend);
}

/** Additive migration keeps existing projects on their original rendering path. */
export function normalizeRenderingPipeline(
  value: unknown,
): RenderingPipelineSettings {
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    renderPath: isRenderPath(source.renderPath) ? source.renderPath : "forward",
    gpuBackend: isGpuBackend(source.gpuBackend) ? source.gpuBackend : "webgl2",
  };
}

/** Invalid or deleted override fields resume live inheritance. */
export function normalizeRenderPathOverrides(
  value: unknown,
): RenderPathOverrides {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  return isRenderPath(source.renderPath)
    ? { renderPath: source.renderPath }
    : {};
}

export interface ResolvedRenderingPipeline {
  requested: RenderingPipelineSettings;
  effective: { renderPath: "forward"; gpuBackend: "webgl2" };
  limits: string[];
}

/**
 * Resolve the currently implemented renderer policy at load/reconfiguration.
 * This is not a device capability probe: Engine creation must still verify
 * WebGL2 availability. Unsupported requests stay authored for future support.
 */
export function resolveRenderingPipeline(
  project?: Partial<RenderingPipelineSettings>,
  scene?: RenderPathOverrides,
  local?: RenderPathOverrides,
  session?: RenderPathOverrides,
): ResolvedRenderingPipeline {
  const requested = {
    ...normalizeRenderingPipeline(project),
    ...normalizeRenderPathOverrides(scene),
    ...normalizeRenderPathOverrides(local),
    ...normalizeRenderPathOverrides(session),
  };
  const limits: string[] = [];
  if (requested.renderPath === "clusteredForward") {
    limits.push("Clustered Forward is unavailable; using Forward.");
  }
  if (requested.gpuBackend === "webgpu") {
    limits.push("WebGPU is unavailable; using WebGL2.");
  }
  return {
    requested,
    effective: { renderPath: "forward", gpuBackend: "webgl2" },
    limits,
  };
}
