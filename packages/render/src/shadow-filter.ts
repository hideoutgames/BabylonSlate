import { AtlasCascadedShadowGenerator, type AtlasShadowGenerator } from "./shadow-atlas";

/**
 * The light block's shadow filter (`hapticShadowGlsl`/`hapticShadowWgsl`): Castaño's exact bilinear compare kernels,
 * which one a view takes, its texture fetches and how far it reads.
 */

/** The kernels' widths in texels: 3 × 3 (four taps), 5 × 5 (nine) and 7 × 7 (sixteen). */
export type ShadowKernelTexels = 3 | 5 | 7;

/**
 * A view's texel ratio: its reference world texel (the sun's first cascade's; a local light's at its requested map
 * size) over its own, on its coarser axis, at most 1. The light block multiplies its quality's kernel width by it.
 */
export function shadowKernelRatio(referenceTexel: { x: number; y: number }, texel: { x: number; y: number }): number {
  const ratio = Math.min(referenceTexel.x / texel.x, referenceTexel.y / texel.y);
  return Number.isFinite(ratio) && ratio > 0 ? Math.min(1, ratio) : 1;
}

/**
 * Per view (tile) of `shadow`, its texel ratio (`shadowKernelRatio`): a cascade's world texel from its extents over its
 * tile, against the first cascade's; a local light's tiles against its requested map size (`filterReferenceSize`).
 */
export function shadowViewTexelRatios(shadow: AtlasShadowGenerator | AtlasCascadedShadowGenerator): number[] {
  if (shadow instanceof AtlasCascadedShadowGenerator) {
    const texel = (index: number) => {
      const size = shadow.tiles[index]!.size;
      const min = shadow.getCascadeMinExtents(index), max = shadow.getCascadeMaxExtents(index);
      return min && max ? { x: (max.x - min.x) / size, y: (max.y - min.y) / size } : { x: 0, y: 0 };
    };
    const reference = texel(0);
    return shadow.tiles.map((_, index) => shadowKernelRatio(reference, texel(index)));
  }
  const requested = shadow.filterReferenceSize;
  return shadow.tiles.map((tile) => requested > 0 ? shadowKernelRatio({ x: 1 / requested, y: 1 / requested }, { x: 1 / tile.size, y: 1 / tile.size }) : 1);
}

/**
 * The kernel a view of texel `ratio` filters with at `quality`, as the light block chooses it: the quality's width
 * (7 × 7 texels at high, 5 × 5 at medium) times the ratio, to the nearest kernel no wider. Holding the width in the
 * world this way keeps each kernel's exact weights, which a kernel stretched to a fractional width loses (it dips and
 * steps). Null at low quality, one bilinear tap.
 */
export function shadowKernelTexels(quality: "low" | "medium" | "high", ratio: number): ShadowKernelTexels | null {
  if (quality === "low") return null;
  const wide = (quality === "medium" ? 5 : 7) * ratio;
  return wide >= 6 ? 7 : wide >= 4 ? 5 : 3;
}

/** Texture fetches per shaded pixel and view: the kernel's taps; low quality's one, or four with receiver-plane bias. */
export function shadowFilterFetches(quality: "low" | "medium" | "high", ratio: number, receiverPlane: boolean): number {
  const kernel = shadowKernelTexels(quality, ratio);
  if (kernel === null) return receiverPlane ? 4 : 1;
  return kernel === 7 ? 16 : kernel === 5 ? 9 : 4;
}

/**
 * How far the widest kernel reads from the position, in texels: its outer taps lie up to 3.2 texels out and each
 * compares the texels within one of it. A receiver-plane comparison extrapolates the receiver's plane that far.
 */
export const SHADOW_FILTER_REACH_TEXELS = 4;
