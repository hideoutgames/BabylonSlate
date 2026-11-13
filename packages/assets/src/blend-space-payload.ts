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

export function normalizeBlendSpacePayload(value: unknown): BlendSpacePayload {
  const record = asRecord(value);
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
  const skeletonGuid = trimmed(record.skeletonGuid);
  return { skeletonGuid: skeletonGuid || null, axes, samples };
}

export function createDefaultBlendSpacePayload(skeletonGuid: string | null): BlendSpacePayload {
  return { skeletonGuid, axes: [defaultBlendSpaceAxis(0)], samples: [] };
}

/** The Skeleton and every sample's Animation, which a Blend Space needs loaded with it. */
export function blendSpaceAssetGuids(payload: unknown): string[] {
  const blendSpace = normalizeBlendSpacePayload(payload);
  const guids = new Set<string>();
  if (blendSpace.skeletonGuid) guids.add(blendSpace.skeletonGuid);
  for (const sample of blendSpace.samples) guids.add(sample.animationGuid);
  return [...guids].sort();
}
