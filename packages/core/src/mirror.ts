export const MIRROR_CLASS_ID = "MirrorComponent";

/** Lowest Resolution Scale: below it a reflection is too coarse to read as a mirror. */
export const MIN_MIRROR_RESOLUTION_SCALE = 0.1;

/** Authored data only. The reflection target, mirror camera and surface mesh belong to the view. */
export type MirrorProperties = {
  enabled: boolean;
  /** Surface size along the component's local X and Y; actor and component scale also apply. */
  width: number;
  height: number;
  /** Reflection resolution as a fraction of the view's, from `MIN_MIRROR_RESOLUTION_SCALE` to 1. */
  resolutionScale: number;
  /** Multiplies the reflection on the built-in surface; a Material override decides its own look. */
  tint: [number, number, number];
  /** Material override for the surface; null draws the built-in mirror surface. */
  materialGuid: string | null;
};

export function parseMirrorProperties(value: unknown): MirrorProperties {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const finite = (entry: unknown): entry is number => typeof entry === "number" && Number.isFinite(entry);
  const positive = (entry: unknown, fallback: number) => finite(entry) && entry > 0 ? entry : fallback;
  const tint = Array.isArray(source.tint) && source.tint.length === 3 && source.tint.every(finite)
    ? source.tint.map((channel: number) => Math.min(1, Math.max(0, channel))) as [number, number, number]
    : [1, 1, 1] as [number, number, number];
  return {
    enabled: source.enabled !== false,
    width: positive(source.width, 2),
    height: positive(source.height, 2),
    resolutionScale: finite(source.resolutionScale)
      ? Math.min(1, Math.max(MIN_MIRROR_RESOLUTION_SCALE, source.resolutionScale))
      : 1,
    tint,
    materialGuid: typeof source.materialGuid === "string" && source.materialGuid.trim() ? source.materialGuid.trim() : null,
  };
}
