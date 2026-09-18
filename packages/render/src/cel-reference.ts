/**
 * CPU mirror of the CEL fragment functions in `cel-shader.ts`; kept for tests
 * that verify rendered pixels against the exact hard-step contract. Both
 * functions must stay in lockstep with the GLSL `slateCelBand` and
 * `slateCelHighlight` (and their WGSL translation).
 */

/** `slateCelBand`: hard-quantized lighting ramp with the midpoint exposure curve. */
export function celBandReference(
  value: number,
  bands: number,
  midpoint: number,
): number {
  const levels = bands - 1;
  const shifted =
    Math.pow(
      Math.min(1, Math.max(0, value)),
      Math.log(0.5) / Math.log(midpoint),
    ) * levels;
  return Math.min(1, Math.max(0, Math.floor(shifted + 0.5001) / levels));
}

/** `slateCelHighlight`: the stylized highlight is exactly strength or zero. */
export function celHighlightReference(
  ndh: number,
  ndl: number,
  size: number,
  strength: number,
): number {
  const edge = 1 - size;
  return (ndh >= edge - 0.00001 ? 1 : 0) * (ndl >= 0.00001 ? 1 : 0) * strength;
}
