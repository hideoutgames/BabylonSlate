export const MIRROR_CLASS_ID = "MirrorComponent";

/** Lowest Resolution Scale: below it a reflection is too coarse to read as a mirror. */
const MIN_MIRROR_RESOLUTION_SCALE = 0.1;

/**
 * What a Mirror draws live, most first. `movingActors` draws only the actors that can move (every actor a Reflection
 * Probe does not capture: `reflectionProbeStaticActors`) and shows the rest from the Reflection Probe the Mirror stands
 * in, or the sky; `environment` draws nothing and shows only that.
 */
export const MIRROR_REFLECTS = ["everything", "movingActors", "environment"] as const;
export type MirrorReflects = (typeof MIRROR_REFLECTS)[number];

/** What a Mirror that asks for `reflects` draws under a quality level's `cap`: the one of the two that draws less. */
export function capMirrorReflects(reflects: MirrorReflects, cap: MirrorReflects): MirrorReflects {
  return MIRROR_REFLECTS.indexOf(cap) > MIRROR_REFLECTS.indexOf(reflects) ? cap : reflects;
}

/** Authored data only. The reflection target, mirror camera and surface mesh belong to the view. */
export type MirrorProperties = {
  enabled: boolean;
  reflects: MirrorReflects;
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
    reflects: MIRROR_REFLECTS.includes(source.reflects as MirrorReflects) ? source.reflects as MirrorReflects : "everything",
    width: positive(source.width, 2),
    height: positive(source.height, 2),
    resolutionScale: finite(source.resolutionScale)
      ? Math.min(1, Math.max(MIN_MIRROR_RESOLUTION_SCALE, source.resolutionScale))
      : 1,
    tint,
    materialGuid: typeof source.materialGuid === "string" && source.materialGuid.trim() ? source.materialGuid.trim() : null,
  };
}
