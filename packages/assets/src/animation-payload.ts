import { normalizeAnimationRootMotion, type AnimationRootMotion } from "./animation-root-motion";
import { animationEventActionGuids, normalizeAnimationEvents, type AnimationEventPayload } from "./animation-events";

export interface AnimationPayload {
  clipName: string;
  modelGuid: string;
  skeletonGuid: string | null;
  /** Length of one playback pass; authored in the Inspector, defaults to `clipDurationMs`. */
  durationMs?: number;
  /** The clip's length in its source file, set at import; Reset restores `durationMs` to it. */
  clipDurationMs?: number;
  sourceAnimationGuid?: string | null;
  /** Animation Events, by time; absent when there are none. */
  events?: AnimationEventPayload[];
  /** Present when the Animation is additive: a change from a base pose that Apply Additive adds to another pose. */
  additive?: AnimationAdditive;
  /** Present when the Animation drives its actor by root motion: the root bone and its sampled travel and turn. */
  rootMotion?: AnimationRootMotion;
}

/** What an additive Animation is a change from: the Skeleton's rest pose, its own first frame, or another Animation's pose. */
export const ANIMATION_ADDITIVE_BASES = ["restPose", "firstFrame", "animation"] as const;
export type AnimationAdditiveBase = (typeof ANIMATION_ADDITIVE_BASES)[number];

export interface AnimationAdditive {
  base: AnimationAdditiveBase;
  /** `animation` base: the Animation whose pose the change is from, at `timeMs` into its Duration. */
  animationGuid?: string;
  timeMs?: number;
}

/** An Animation's additive settings as stored, cleaned; undefined when it is not additive. */
export function normalizeAnimationAdditive(value: unknown): AnimationAdditive | undefined {
  const record = asRecord(value);
  const base = ANIMATION_ADDITIVE_BASES.find((entry) => entry === record.base);
  if (!base) return undefined;
  if (base !== "animation") return { base };
  const animationGuid = trimmed(record.animationGuid);
  const timeMs = typeof record.timeMs === "number" && Number.isFinite(record.timeMs) && record.timeMs > 0 ? record.timeMs : 0;
  return { base, ...(animationGuid ? { animationGuid } : {}), timeMs };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullableGuid(value: unknown): string | null {
  const guid = trimmed(value);
  return guid.length > 0 ? guid : null;
}

function optionalDurationMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

export function normalizeAnimationPayload(value: unknown): AnimationPayload {
  const record = asRecord(value);
  const payload: AnimationPayload = {
    clipName: trimmed(record.clipName),
    modelGuid: trimmed(record.modelGuid),
    skeletonGuid: nullableGuid(record.skeletonGuid),
    sourceAnimationGuid: nullableGuid(record.sourceAnimationGuid),
  };
  const clipDurationMs = optionalDurationMs(record.clipDurationMs);
  const durationMs = optionalDurationMs(record.durationMs) ?? clipDurationMs;
  if (durationMs !== undefined) payload.durationMs = durationMs;
  if (clipDurationMs !== undefined) payload.clipDurationMs = clipDurationMs;
  const events = normalizeAnimationEvents(record.events);
  if (events.length > 0) payload.events = events;
  const additive = normalizeAnimationAdditive(record.additive);
  if (additive) payload.additive = additive;
  const rootMotion = normalizeAnimationRootMotion(record.rootMotion);
  if (rootMotion) payload.rootMotion = rootMotion;
  return payload;
}

export function animationAssetGuids(payload: unknown): string[] {
  const animation = normalizeAnimationPayload(payload);
  const guids = new Set<string>();
  if (animation.modelGuid) guids.add(animation.modelGuid);
  if (animation.skeletonGuid) guids.add(animation.skeletonGuid);
  if (animation.sourceAnimationGuid) guids.add(animation.sourceAnimationGuid);
  for (const guid of animationEventActionGuids(animation.events ?? [])) guids.add(guid);
  // An additive Animation's base Animation loads with it, so its pose is there to take the change from.
  if (animation.additive?.animationGuid) guids.add(animation.additive.animationGuid);
  return [...guids].sort();
}

/** Native (non-retargeted) clipName → Animation guid, keyed by owning Model. */
export function modelClipAnimationGuidsFromAnimations(
  animations: ReadonlyArray<{ guid: string; payload: AnimationPayload }>,
): Map<string, Map<string, string>> {
  const byModel = new Map<string, Map<string, string>>();
  for (const animation of animations) {
    if (animation.payload.sourceAnimationGuid) continue;
    const modelGuid = animation.payload.modelGuid.trim();
    const clipName = animation.payload.clipName.trim();
    if (!modelGuid || !clipName) continue;
    let clips = byModel.get(modelGuid);
    if (!clips) {
      clips = new Map();
      byModel.set(modelGuid, clips);
    }
    clips.set(clipName, animation.guid);
  }
  return byModel;
}

export type RetargetAnimationLoad = {
  animationGuid: string;
  clipName: string;
  /** The Model whose file holds the clip. */
  sourceModelGuid: string;
  /**
   * The clip is another Model's own on the same Skeleton: it binds to this Model's nodes by name, unchanged. Without
   * it the clip is retargeted onto this Model.
   */
  bindByName?: true;
};

/**
 * The clips each Model plays from other files, keyed by that Model's guid: Animations retargeted onto it, and every
 * Animation on its Skeleton that another Model's file holds. `modelSkeletons` gives each Model's Skeleton guid.
 */
export function retargetAnimationLoadsFromAnimations(
  animations: ReadonlyArray<{ guid: string; payload: AnimationPayload }>,
  modelSkeletons: ReadonlyMap<string, string | null> = new Map(),
): Map<string, RetargetAnimationLoad[]> {
  const byGuid = new Map(animations.map((entry) => [entry.guid, entry] as const));
  const byTarget = new Map<string, RetargetAnimationLoad[]>();
  const add = (targetModelGuid: string, row: RetargetAnimationLoad) => {
    let rows = byTarget.get(targetModelGuid);
    if (!rows) {
      rows = [];
      byTarget.set(targetModelGuid, rows);
    }
    if (!rows.some((entry) => entry.animationGuid === row.animationGuid)) rows.push(row);
  };
  const retargetSource = (animation: { payload: AnimationPayload }) => {
    const sourceGuid = animation.payload.sourceAnimationGuid;
    return sourceGuid ? byGuid.get(sourceGuid)?.payload.modelGuid.trim() ?? "" : null;
  };
  for (const animation of animations) {
    const sourceModelGuid = retargetSource(animation);
    const targetModelGuid = animation.payload.modelGuid.trim();
    const clipName = animation.payload.clipName.trim();
    if (sourceModelGuid === null || !sourceModelGuid || !targetModelGuid || !clipName) continue;
    add(targetModelGuid, { animationGuid: animation.guid, clipName, sourceModelGuid });
  }
  const animationsBySkeleton = new Map<string, Array<{ guid: string; payload: AnimationPayload }>>();
  for (const animation of animations) {
    const skeletonGuid = animation.payload.skeletonGuid;
    if (!skeletonGuid) continue;
    const rows = animationsBySkeleton.get(skeletonGuid) ?? [];
    rows.push(animation);
    animationsBySkeleton.set(skeletonGuid, rows);
  }
  for (const [modelGuid, skeletonGuid] of modelSkeletons) {
    if (!skeletonGuid) continue;
    for (const animation of animationsBySkeleton.get(skeletonGuid) ?? []) {
      const clipName = animation.payload.clipName.trim();
      const ownerGuid = animation.payload.modelGuid.trim();
      if (!clipName || !ownerGuid || ownerGuid === modelGuid) continue;
      const sourceModelGuid = retargetSource(animation);
      if (sourceModelGuid === null) {
        add(modelGuid, { animationGuid: animation.guid, clipName, sourceModelGuid: ownerGuid, bindByName: true });
      } else if (sourceModelGuid) {
        add(modelGuid, { animationGuid: animation.guid, clipName, sourceModelGuid });
      }
    }
  }
  return byTarget;
}
