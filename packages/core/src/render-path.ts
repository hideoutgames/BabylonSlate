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
  effective: {
    renderPath: "forward" | "clusteredForward";
    gpuBackend: "webgl2" | "webgpu";
  };
  limits: string[];
}

/** Scene-owned capability and compatibility evidence, with no renderer objects. */
export type ClusteredRenderingAvailability =
  | { supported: true; autoEligible: boolean }
  | { supported: false; reason: string };

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
  backend?: { gpuBackend: "webgl2" | "webgpu"; reason?: string },
  clustered?: ClusteredRenderingAvailability,
): ResolvedRenderingPipeline {
  const requested = {
    ...normalizeRenderingPipeline(project),
    ...normalizeRenderPathOverrides(scene),
    ...normalizeRenderPathOverrides(local),
    ...normalizeRenderPathOverrides(session),
  };
  const limits: string[] = [];
  let renderPath: "forward" | "clusteredForward" = "forward";
  if (requested.renderPath !== "forward") {
    if (backend?.gpuBackend === "webgpu") {
      limits.push(
        "Clustered Forward requires WebGL2; using Forward on WebGPU.",
      );
    } else if (clustered?.supported === true) {
      if (requested.renderPath === "clusteredForward" || clustered.autoEligible)
        renderPath = "clusteredForward";
    } else if (clustered?.supported === false) {
      limits.push(clustered.reason);
    } else if (requested.renderPath === "clusteredForward") {
      limits.push(
        "Clustered Forward awaits scene capability checks; using Forward.",
      );
    }
  }
  if (backend?.reason) limits.push(backend.reason);
  else if (!backend && requested.gpuBackend === "webgpu") {
    limits.push("WebGPU is not active; using WebGL2.");
  }
  return {
    requested,
    effective: { renderPath, gpuBackend: backend?.gpuBackend ?? "webgl2" },
    limits,
  };
}
