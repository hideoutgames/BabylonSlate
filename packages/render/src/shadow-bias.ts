export type DirectionalShadowBiasInput = {
  /** Current orthographic projection spans, in world units. */
  width: number;
  height: number;
  depth: number;
  /** Actual allocation dimensions, after admission and allocation recovery. */
  mapWidth: number;
  mapHeight: number;
  filter: "pcf" | "pcss" | "poisson" | "none";
  filterQuality: "low" | "medium" | "high";
  /** Effective native CSM depth clamp, not merely the requested setting. */
  depthClamp: boolean;
  /** Native blurScale controls the Poisson sample radius in texels. */
  poissonRadiusTexels?: number;
  authoredDepthBias: number;
  authoredNormalBias: number;
};

export type DirectionalShadowBias = {
  bias: number;
  normalBias: number;
  worldTexelSize: number;
  /** Normalized comparison-depth change per unit of native generator.bias. */
  depthScale: number;
};

function nonNegativeFinite(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * Automatic bias for orthographic directional maps only. Authored depth bias
 * is a native-unit floor; authored normal bias is the world-space floor AND
 * bound. Automatically insetting split-normal vertices can open hard contacts,
 * so adaptation adds no normal displacement.
 *
 * Babylon 9.20's GLSL and WGSL shadowMapVertexMetric apply half of native bias
 * to normalized hardware depth, including reverse depth. CSM depth clamping
 * writes that metric plus another native bias in shadowMapFragment (1.5 total).
 * Color-depth filters add one native bias. PCSS uses hardware depth for its
 * final comparison, while its separate blocker color metric receives 1.5.
 */
export function resolveDirectionalShadowBias(
  input: DirectionalShadowBiasInput,
): DirectionalShadowBias {
  const hardwareDepth = input.filter === "pcf" || input.filter === "pcss";
  const depthScale = hardwareDepth
    ? input.depthClamp && input.filter !== "pcss"
      ? 1.5
      : 0.5
    : 1;
  const result: DirectionalShadowBias = {
    bias: nonNegativeFinite(input.authoredDepthBias),
    normalBias: nonNegativeFinite(input.authoredNormalBias),
    worldTexelSize: 0,
    depthScale,
  };
  if (
    !positiveFinite(input.width) ||
    !positiveFinite(input.height) ||
    !positiveFinite(input.depth) ||
    !positiveFinite(input.mapWidth) ||
    !positiveFinite(input.mapHeight)
  )
    return result;

  const worldTexelSize = Math.max(
    input.width / input.mapWidth,
    input.height / input.mapHeight,
  );
  if (!positiveFinite(worldTexelSize)) return result;
  result.worldTexelSize = worldTexelSize;

  // Native PCF uses 1/3/5-tap-width reconstruction. PCSS quality changes sample
  // count, not a fixed filter width, so it uses only the base raster correction.
  // Poisson quality is ignored by Babylon; its radius is controlled by blurScale.
  const footprint =
    input.filter === "pcf"
      ? input.filterQuality === "high"
        ? 5
        : input.filterQuality === "medium"
          ? 3
          : 1
      : input.filter === "poisson"
        ? Math.max(1, 2 * nonNegativeFinite(input.poissonRadiusTexels ?? 2))
        : 1;
  const normalizedCorrection = (0.5 * footprint * worldTexelSize) / input.depth;
  // Match the authored native-depth range for pathological/recovering extents.
  // This is a numerical guard, not a guarantee for arbitrary thin geometry.
  result.bias = Math.max(
    result.bias,
    Math.min(0.05, normalizedCorrection / depthScale),
  );
  return result;
}
