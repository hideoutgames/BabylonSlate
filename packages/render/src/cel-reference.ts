/**
 * CPU mirror of the CEL band fragment function in `cel-shader.ts`; kept for
 * tests that verify rendered pixels against the exact hard-step contract. It
 * must stay in lockstep with the GLSL `slateCelBand` (and its WGSL translation).
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
