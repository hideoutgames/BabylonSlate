/**
 * The world-to-clip scale of the cascade whose view-projection is `m`: the larger of its x and y axes' world scales.
 * It depends on the cascade alone, so a caller testing many casters against one cascade computes it once.
 */
export function cascadeTexelScale(m: ArrayLike<number>): number {
  return Math.max(Math.hypot(m[0]!, m[4]!, m[8]!), Math.hypot(m[1]!, m[5]!, m[9]!));
}

/**
 * Whether a caster with a bounding sphere of `radius` covers at least `minTexels` texels across a cascade of world-to-clip
 * `scale` (`cascadeTexelScale`), drawn into a `size`-texel tile: clip space spans two units across the tile, so the
 * sphere's diameter in texels is its radius times the scale times the size.
 */
export function castsIntoCascade(scale: number, radius: number, size: number, minTexels: number): boolean {
  if (!(minTexels > 0)) return true;
  // Negated: a non-finite size casts.
  return !(radius * scale * size < minTexels);
}
