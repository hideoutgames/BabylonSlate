/** A quarter of the filter footprint, converted from world texels to depth. */
export function calibratedShadowBias(
  mapSize: number,
  extent: number,
  depth: number,
  quality: "low" | "medium" | "high",
  minimum: number,
): number {
  if (
    !(mapSize > 0 && extent > 0 && depth > 0) ||
    !Number.isFinite(extent / depth)
  )
    return minimum;
  const kernel = quality === "high" ? 5 : quality === "medium" ? 3 : 1;
  return Math.max(minimum, (0.25 * kernel * extent) / (mapSize * depth));
}
