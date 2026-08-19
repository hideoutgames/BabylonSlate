export interface AnimationPayload {
  clipName: string;
  modelGuid: string;
  skeletonGuid: string | null;
  durationMs?: number;
  sourceAnimationGuid?: string | null;
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
  const durationMs = optionalDurationMs(record.durationMs);
  if (durationMs !== undefined) payload.durationMs = durationMs;
  return payload;
}

export function remapAnimationPayloadGuids(
  assetType: string,
  payload: Record<string, unknown>,
  remap: ReadonlyMap<string, string>,
): Record<string, unknown> {
  if (assetType !== "Animation") return payload;
  const animation = normalizeAnimationPayload(payload);
  return {
    ...animation,
    modelGuid: remap.get(animation.modelGuid) ?? animation.modelGuid,
    skeletonGuid: animation.skeletonGuid
      ? (remap.get(animation.skeletonGuid) ?? animation.skeletonGuid)
      : null,
    sourceAnimationGuid: animation.sourceAnimationGuid
      ? (remap.get(animation.sourceAnimationGuid) ?? animation.sourceAnimationGuid)
      : null,
  };
}

export function animationAssetGuids(payload: unknown): string[] {
  const animation = normalizeAnimationPayload(payload);
  const guids = new Set<string>();
  if (animation.modelGuid) guids.add(animation.modelGuid);
  if (animation.skeletonGuid) guids.add(animation.skeletonGuid);
  if (animation.sourceAnimationGuid) guids.add(animation.sourceAnimationGuid);
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
  sourceModelGuid: string;
};

/** Retargeted clip loads keyed by the actor (target) Model guid. */
export function retargetAnimationLoadsFromAnimations(
  animations: ReadonlyArray<{ guid: string; payload: AnimationPayload }>,
): Map<string, RetargetAnimationLoad[]> {
  const byGuid = new Map(animations.map((entry) => [entry.guid, entry] as const));
  const byTarget = new Map<string, RetargetAnimationLoad[]>();
  for (const animation of animations) {
    const sourceGuid = animation.payload.sourceAnimationGuid;
    if (!sourceGuid) continue;
    const source = byGuid.get(sourceGuid);
    const sourceModelGuid = source?.payload.modelGuid.trim() ?? "";
    const targetModelGuid = animation.payload.modelGuid.trim();
    const clipName = animation.payload.clipName.trim();
    if (!sourceModelGuid || !targetModelGuid || !clipName) continue;
    let rows = byTarget.get(targetModelGuid);
    if (!rows) {
      rows = [];
      byTarget.set(targetModelGuid, rows);
    }
    rows.push({
      animationGuid: animation.guid,
      clipName,
      sourceModelGuid,
    });
  }
  return byTarget;
}
