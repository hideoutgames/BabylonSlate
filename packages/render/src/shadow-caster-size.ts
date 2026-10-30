/**
 * Whether a caster with a bounding sphere of `radius` covers at least `minTexels` texels across the cascade whose
 * view-projection is `m`, drawn into a `size`-texel tile: clip space spans two units across the tile, so the sphere's
 * diameter in texels is its radius times the cascade's world-to-clip scale times the size.
 */
export function castsIntoCascade(m: ArrayLike<number>, radius: number, size: number, minTexels: number): boolean {
  if (!(minTexels > 0)) return true;
  const scale = Math.max(Math.hypot(m[0]!, m[4]!, m[8]!), Math.hypot(m[1]!, m[5]!, m[9]!));
  // Negated: a non-finite size casts.
  return !(radius * scale * size < minTexels);
}
