import { NullEngine, NullEngineOptions } from "@babylonjs/core/Engines/nullEngine";

/**
 * Babylon's matrix precision is page-global: every Engine constructor, a `NullEngine`'s included, sets the type later
 * matrices are built with (`PerformanceConfigurator.SetMatrixPrecision`), and only the page's first Engine converts the
 * matrices that already exist (Babylon's own temporaries among them). Every Engine the page builds therefore asks for
 * 64-bit matrices, whatever its project's Large World Rendering: an Engine or a model conversion's `NullEngine` built
 * at 32 bits would leave a later large-world Engine rounding positions far from the origin before it subtracts the eye.
 */
export const PAGE_MATRIX_PRECISION = { useHighPrecisionMatrix: true } as const;

/**
 * The Engine options for a project's Large World Rendering (`RenderProjectSettings.largeWorldRendering`): Babylon's
 * floating origin (`useLargeWorldRendering`), which every Scene on the Engine takes at construction, so the mode is the
 * Engine's for its life. Matrices stay 64-bit either way (`PAGE_MATRIX_PRECISION`).
 */
export function largeWorldEngineOptions(largeWorldRendering: boolean): { useLargeWorldRendering: boolean; useHighPrecisionMatrix: true } {
  return { useLargeWorldRendering: largeWorldRendering, ...PAGE_MATRIX_PRECISION };
}

/** A headless Engine (model conversion, tests) that keeps the page's 64-bit matrices (`PAGE_MATRIX_PRECISION`). */
export function createHeadlessEngine(): NullEngine {
  const options = new NullEngineOptions();
  options.useHighPrecisionMatrix = PAGE_MATRIX_PRECISION.useHighPrecisionMatrix;
  return new NullEngine(options);
}
