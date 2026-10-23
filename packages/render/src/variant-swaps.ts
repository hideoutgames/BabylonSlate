/**
 * Variant swaps: a Material keeps drawing its previous Effect while a variant a change requested (a light switched
 * off, a shadow lost, a grown light capacity) still compiles, Babylon's `allowShaderHotSwapping`. Readiness probes
 * never replace a drawn Effect. Inside `probeVariantSwaps(true, …)` (a world view's steady frames) a swapping mesh is
 * ready; otherwise (loading, presentation checks, previews) it is not ready until its new variant is drawn.
 */
let tolerated = false;
let swaps = 0;

/** Runs `probe` with swapping meshes counted as ready (`tolerate`) or not. Nested scopes restore the outer one. */
export function probeVariantSwaps<T>(tolerate: boolean, probe: () => T): T {
  const outer = tolerated;
  tolerated = tolerate;
  try {
    return probe();
  } finally {
    tolerated = outer;
  }
}

export function variantSwapsTolerated(): boolean {
  return tolerated;
}

/** A probe found a mesh drawing its previous Effect. */
export function noteVariantSwap(): void {
  swaps += 1;
}

/** Monotonic count of swaps probes found; a probe compares it before and after. */
export function variantSwapCount(): number {
  return swaps;
}
