/** One axis of a Blend Space: what drives it, its range and how it moves. */
export interface BlendSpaceAxisPayload {
  name: string;
  min: number;
  max: number;
  /** Grid cells across the range; samples snap to the grid lines. */
  gridDivisions: number;
  /** How long an input change takes to settle; 0 follows the input at once. */
  smoothingSeconds: number;
  /** Joins the ends, for an angle such as Direction. */
  wrap: boolean;
}

/** An Animation placed on the grid. */
export interface BlendSpaceSamplePayload {
  animationGuid: string;
  x: number;
  y: number;
  /** Scales the sample's playback; 1 plays it at its Duration. */
  rateScale: number;
}

/** Animations on one Skeleton, placed on one or two axes and blended by where the input falls among them. */
export interface BlendSpacePayload {
  skeletonGuid: string | null;
  /** The Model the editor's Preview shows; editor only. Null shows the first Model on the Skeleton. */
  previewModelGuid: string | null;
  axes: [BlendSpaceAxisPayload] | [BlendSpaceAxisPayload, BlendSpaceAxisPayload];
  samples: BlendSpaceSamplePayload[];
}

export const BLEND_SPACE_MAX_GRID_DIVISIONS = 64;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The first axis of a new Blend Space: Speed in m/s. */
export function defaultBlendSpaceAxis(index: 0 | 1): BlendSpaceAxisPayload {
  return index === 0
    ? { name: "Speed", min: 0, max: 6, gridDivisions: 6, smoothingSeconds: 0, wrap: false }
    : { name: "Direction", min: -180, max: 180, gridDivisions: 8, smoothingSeconds: 0, wrap: true };
}

function normalizeAxis(value: unknown, index: 0 | 1): BlendSpaceAxisPayload {
  const record = asRecord(value);
  const fallback = defaultBlendSpaceAxis(index);
  const a = finite(record.min, fallback.min);
  const b = finite(record.max, fallback.max);
  const min = Math.min(a, b);
  // An empty range cannot place samples apart.
  const max = Math.max(a, b) > min ? Math.max(a, b) : min + 1;
  return {
    name: trimmed(record.name) || fallback.name,
    min,
    max,
    gridDivisions: Math.min(
      BLEND_SPACE_MAX_GRID_DIVISIONS,
      Math.max(1, Math.round(finite(record.gridDivisions, fallback.gridDivisions))),
    ),
    smoothingSeconds: Math.max(0, finite(record.smoothingSeconds, fallback.smoothingSeconds)),
    wrap: typeof record.wrap === "boolean" ? record.wrap : fallback.wrap,
  };
}

/** The axes and samples both Blend Space kinds share. */
export type BlendSpaceLayoutPayload = Pick<BlendSpacePayload, "axes" | "samples">;

function normalizeLayout(record: Record<string, unknown>): BlendSpaceLayoutPayload {
  const rawAxes = Array.isArray(record.axes) ? record.axes : [];
  const first = normalizeAxis(rawAxes[0], 0);
  const axes: BlendSpacePayload["axes"] = rawAxes.length >= 2 ? [first, normalizeAxis(rawAxes[1], 1)] : [first];
  const samples = (Array.isArray(record.samples) ? record.samples : []).flatMap((entry): BlendSpaceSamplePayload[] => {
    const sample = asRecord(entry);
    const animationGuid = trimmed(sample.animationGuid);
    if (!animationGuid) return [];
    const rateScale = finite(sample.rateScale, 1);
    return [{
      animationGuid,
      x: finite(sample.x, axes[0].min),
      y: axes[1] ? finite(sample.y, axes[1].min) : 0,
      rateScale: rateScale > 0 ? rateScale : 1,
    }];
  });
  return { axes, samples };
}

export function normalizeBlendSpacePayload(value: unknown): BlendSpacePayload {
  const record = asRecord(value);
  const { axes, samples } = normalizeLayout(record);
  const skeletonGuid = trimmed(record.skeletonGuid);
  const previewModelGuid = trimmed(record.previewModelGuid);
  return { skeletonGuid: skeletonGuid || null, previewModelGuid: previewModelGuid || null, axes, samples };
}

export function createDefaultBlendSpacePayload(skeletonGuid: string | null): BlendSpacePayload {
  return { skeletonGuid, previewModelGuid: null, axes: [defaultBlendSpaceAxis(0)], samples: [] };
}

/** The Skeleton and every sample's Animation, which a Blend Space needs loaded with it. */
export function blendSpaceAssetGuids(payload: unknown): string[] {
  const blendSpace = normalizeBlendSpacePayload(payload);
  const guids = new Set<string>();
  if (blendSpace.skeletonGuid) guids.add(blendSpace.skeletonGuid);
  for (const sample of blendSpace.samples) guids.add(sample.animationGuid);
  return [...guids].sort();
}

/**
 * Sprite Animations placed on one or two axes. The sample nearest the input plays alone: frames cannot blend.
 * `hysteresis` keeps the playing sample until another is nearer by that much (in grid widths), so an input on a
 * boundary does not flicker; `keepTime` carries the cycle's position to the next sample instead of starting it over.
 */
export interface SpriteBlendSpacePayload extends BlendSpaceLayoutPayload {
  hysteresis: number;
  keepTime: boolean;
}

export const SPRITE_BLEND_SPACE_DEFAULT_HYSTERESIS = 0.05;
export const SPRITE_BLEND_SPACE_MAX_HYSTERESIS = 0.5;

/** The first axis of a new Sprite Blend Space: Direction, wrapping, in eight cells. */
function defaultSpriteBlendSpaceAxis(): BlendSpaceAxisPayload {
  return { name: "Direction", min: -180, max: 180, gridDivisions: 8, smoothingSeconds: 0, wrap: true };
}

export function normalizeSpriteBlendSpacePayload(value: unknown): SpriteBlendSpacePayload {
  const record = asRecord(value);
  const layout = Array.isArray(record.axes) && record.axes.length > 0
    ? normalizeLayout(record)
    : normalizeLayout({ ...record, axes: [defaultSpriteBlendSpaceAxis()] });
  const hysteresis = Math.min(
    SPRITE_BLEND_SPACE_MAX_HYSTERESIS,
    Math.max(0, finite(record.hysteresis, SPRITE_BLEND_SPACE_DEFAULT_HYSTERESIS)),
  );
  return { ...layout, hysteresis, keepTime: record.keepTime !== false };
}

export function createDefaultSpriteBlendSpacePayload(): SpriteBlendSpacePayload {
  return { axes: [defaultSpriteBlendSpaceAxis()], samples: [], hysteresis: SPRITE_BLEND_SPACE_DEFAULT_HYSTERESIS, keepTime: true };
}

/** Every sample's Sprite Animation, which a Sprite Blend Space needs loaded with it. */
export function spriteBlendSpaceAssetGuids(payload: unknown): string[] {
  return [...new Set(normalizeSpriteBlendSpacePayload(payload).samples.map((sample) => sample.animationGuid))].sort();
}
