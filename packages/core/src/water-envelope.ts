import type { WaterSpectrum } from "./water-spectrum";

// Envelope bounds of a spectrum the caller already holds, for per-query paths. Package-internal: index.ts does not
// re-export this module; the public forms that take a WaterDefinition live in water.ts.

/** `waterWaveEnvelope` of a held spectrum: four standard deviations of the sea's height (metres). */
export function waterWaveEnvelopeOf(spectrum: WaterSpectrum, scale: number): number {
  return Math.abs(scale) * 4 * spectrum.sigma;
}

/** `waterHorizontalEnvelope` of a held spectrum: λ times the height envelope (metres). */
export function waterHorizontalEnvelopeOf(spectrum: WaterSpectrum, scale: number): number {
  return spectrum.choppiness * waterWaveEnvelopeOf(spectrum, scale);
}
