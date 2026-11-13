import type { BlendSpaceLayout, BlendSpaceNodeData } from "@haptic/anim-graph";
import {
  defaultBlendSpaceAxis,
  normalizeAnimationPayload,
  parseSpriteAnimationPayload,
  spriteAnimationDurationMs,
  type BlendSpaceAxisPayload,
  type BlendSpaceLayoutPayload,
  type BlendSpaceSamplePayload,
  type SpriteBlendSpacePayload,
} from "@haptic/assets";

/** Either Blend Space kind, by what both share: its axes and samples. */
type Layout = BlendSpaceLayoutPayload;

/** A position on the axes; a one-axis space keeps `y` at 0. */
export type BlendSpacePosition = { x: number; y: number };

/** `value` on the nearest grid line of `axis`, within its range. */
export function snapToBlendSpaceGrid(axis: BlendSpaceAxisPayload, value: number): number {
  const step = (axis.max - axis.min) / Math.max(1, axis.gridDivisions);
  const snapped = axis.min + Math.round((value - axis.min) / step) * step;
  // Round off float noise so a snapped 0.1 step reads 0.3, not 0.30000000000000004.
  return Math.min(axis.max, Math.max(axis.min, Number(snapped.toFixed(6))));
}

/** A position snapped to the grid on each axis the space has. */
export function snapBlendSpacePosition(payload: Layout, position: BlendSpacePosition): BlendSpacePosition {
  const [xAxis, yAxis] = payload.axes;
  return { x: snapToBlendSpaceGrid(xAxis, position.x), y: yAxis ? snapToBlendSpaceGrid(yAxis, position.y) : 0 };
}

/** The space's axes and samples as the weight math reads them. */
export function blendSpaceLayoutOf(payload: Layout): BlendSpaceLayout {
  const [xAxis, yAxis] = payload.axes;
  return {
    axes: yAxis ? [xAxis, yAxis] : [xAxis],
    samples: payload.samples.map((sample) => ({ x: sample.x, y: sample.y })),
  };
}

/** Adds an Animation as a sample at `position`, snapped to the grid. */
export function addBlendSpaceSample<P extends Layout>(
  payload: P,
  animationGuid: string,
  position: BlendSpacePosition,
): P {
  const at = snapBlendSpacePosition(payload, position);
  const sample: BlendSpaceSamplePayload = { animationGuid, x: at.x, y: at.y, rateScale: 1 };
  return { ...payload, samples: [...payload.samples, sample] };
}

/** Moves sample `index` to `position`, snapped to the grid; the same payload when it does not move. */
export function moveBlendSpaceSample<P extends Layout>(payload: P, index: number, position: BlendSpacePosition): P {
  const sample = payload.samples[index];
  if (!sample) return payload;
  const at = snapBlendSpacePosition(payload, position);
  if (at.x === sample.x && at.y === sample.y) return payload;
  return { ...payload, samples: payload.samples.map((entry, i) => (i === index ? { ...entry, ...at } : entry)) };
}

export function patchBlendSpaceSample<P extends Layout>(
  payload: P,
  index: number,
  patch: Partial<BlendSpaceSamplePayload>,
): P {
  if (!payload.samples[index]) return payload;
  return { ...payload, samples: payload.samples.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)) };
}

export function removeBlendSpaceSample<P extends Layout>(payload: P, index: number): P {
  if (!payload.samples[index]) return payload;
  return { ...payload, samples: payload.samples.filter((_, i) => i !== index) };
}

/** One axis drops the second (samples keep their X); two adds the default Direction axis with samples at its minimum. */
export function setBlendSpaceAxisCount<P extends Layout>(payload: P, count: 1 | 2): P {
  if (payload.axes.length === count) return payload;
  if (count === 1) {
    return { ...payload, axes: [payload.axes[0]], samples: payload.samples.map((sample) => ({ ...sample, y: 0 })) };
  }
  const yAxis = defaultBlendSpaceAxis(1);
  return { ...payload, axes: [payload.axes[0], yAxis], samples: payload.samples.map((sample) => ({ ...sample, y: yAxis.min })) };
}

/** Changes axis `index`; a range that would be empty or reversed is refused. */
export function patchBlendSpaceAxis<P extends Layout>(
  payload: P,
  index: 0 | 1,
  patch: Partial<BlendSpaceAxisPayload>,
): P {
  const axis = payload.axes[index];
  if (!axis) return payload;
  const next = { ...axis, ...patch };
  if (!(next.max > next.min)) return payload;
  next.gridDivisions = Math.max(1, Math.round(next.gridDivisions));
  next.smoothingSeconds = Math.max(0, next.smoothingSeconds);
  const axes: Layout["axes"] = index === 0
    ? (payload.axes[1] ? [next, payload.axes[1]] : [next])
    : [payload.axes[0], next];
  return { ...payload, axes };
}

/** Where the Preview plays: the placed point, else the first axis's minimum. */
export function blendSpacePreviewPoint(payload: Layout, point: BlendSpacePosition | null): BlendSpacePosition {
  const [xAxis, yAxis] = payload.axes;
  return point ?? { x: xAxis.min, y: yAxis ? yAxis.min : 0 };
}

/**
 * The Blend Space as a Blend Space Player plays it, each sample with its Animation's clip and Duration (as
 * `resolveAnimGraphClips` fills it in a game); samples whose Animation is missing are left out.
 */
export function blendSpaceNodeDataOf(
  payload: Layout,
  animation: (guid: string) => { payload?: unknown } | undefined,
): BlendSpaceNodeData {
  return {
    axes: payload.axes.map((axis) => ({ min: axis.min, max: axis.max, wrap: axis.wrap, smoothingSeconds: axis.smoothingSeconds })),
    samples: payload.samples.flatMap((sample) => {
      const asset = animation(sample.animationGuid);
      if (!asset) return [];
      const clip = normalizeAnimationPayload(asset.payload ?? {});
      return [{
        animationGuid: sample.animationGuid,
        clipName: clip.clipName,
        durationMs: clip.durationMs ?? 1000,
        x: sample.x,
        y: sample.y,
        rateScale: sample.rateScale,
      }];
    }),
  };
}

/**
 * A Sprite Blend Space as a Sprite Blend Space Player plays it: each sample with its Sprite Animation's length, and
 * the hysteresis and Keep Time; samples whose Sprite Animation is missing are left out.
 */
export function spriteBlendSpaceNodeDataOf(
  payload: SpriteBlendSpacePayload,
  spriteAnimation: (guid: string) => { payload?: unknown } | undefined,
): BlendSpaceNodeData {
  return {
    axes: payload.axes.map((axis) => ({ min: axis.min, max: axis.max, wrap: axis.wrap, smoothingSeconds: axis.smoothingSeconds })),
    samples: payload.samples.flatMap((sample) => {
      const asset = spriteAnimation(sample.animationGuid);
      if (!asset) return [];
      return [{
        animationGuid: sample.animationGuid,
        clipName: "",
        durationMs: Math.max(1, spriteAnimationDurationMs(parseSpriteAnimationPayload(asset.payload ?? {}))),
        x: sample.x,
        y: sample.y,
        rateScale: sample.rateScale,
      }];
    }),
    hysteresis: payload.hysteresis,
    keepTime: payload.keepTime,
  };
}
