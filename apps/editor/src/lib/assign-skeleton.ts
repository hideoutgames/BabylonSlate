import {
  matchSkeletonBones,
  normalizeAnimationPayload,
  normalizeModelPayload,
  normalizeSkeletonPayload,
  type SkeletonPayload,
} from "@haptic/assets";

export interface AssignSkeletonAsset {
  path: string;
  readOnly?: boolean;
  header: { guid: string; type: string; name: string; payload?: unknown };
}

export interface AssignSkeletonEdit {
  kind: "model" | "animation" | "skeleton";
  path: string;
  name: string;
  /** Fields to set on the asset's current content. */
  changes: Record<string, unknown>;
}

/** The Skeletons a Model can move onto: every other Skeleton whose bones match its own Skeleton's. */
export function assignableSkeletons<T extends AssignSkeletonAsset>(assets: readonly T[], modelGuid: string): T[] {
  const current = currentSkeleton(assets, modelGuid);
  if (!current) return [];
  const bones = normalizeSkeletonPayload(current.header.payload ?? {}).bones;
  return assets.filter((asset) =>
    asset.header.type === "Skeleton" && asset.header.guid !== current.header.guid &&
    matchSkeletonBones(normalizeSkeletonPayload(asset.header.payload ?? {}).bones, bones) !== null);
}

function currentSkeleton<T extends AssignSkeletonAsset>(assets: readonly T[], modelGuid: string): T | null {
  const model = assets.find((asset) => asset.header.guid === modelGuid && asset.header.type === "Model");
  const skeletonGuid = model ? normalizeModelPayload(model.header.payload ?? {}).skeletonGuid : null;
  return assets.find((asset) => asset.header.guid === skeletonGuid && asset.header.type === "Skeleton") ?? null;
}

/**
 * Moves a Model and its Animations (its own clips and those retargeted onto it) from its Skeleton onto `targetGuid`.
 * Refused when the bones differ; a Model with extra bones adds them to the target Skeleton.
 */
export function planAssignSkeleton(
  assets: readonly AssignSkeletonAsset[],
  modelGuid: string,
  targetGuid: string,
): { edits: AssignSkeletonEdit[] } | { error: string } {
  const model = assets.find((asset) => asset.header.guid === modelGuid && asset.header.type === "Model");
  if (!model) return { error: "The Model no longer exists." };
  const current = currentSkeleton(assets, modelGuid);
  if (!current) return { error: `${model.header.name} has no Skeleton.` };
  const target = assets.find((asset) => asset.header.guid === targetGuid && asset.header.type === "Skeleton");
  if (!target) return { error: "The Skeleton no longer exists." };
  if (target.header.guid === current.header.guid) return { edits: [] };
  const targetPayload = normalizeSkeletonPayload(target.header.payload ?? {});
  const currentPayload = normalizeSkeletonPayload(current.header.payload ?? {});
  const match = matchSkeletonBones(targetPayload.bones, currentPayload.bones);
  if (!match) return { error: `The bones of ${target.header.name} differ from ${current.header.name}'s.` };
  const animations = assets.filter((asset) => {
    if (asset.header.type !== "Animation") return false;
    const payload = normalizeAnimationPayload(asset.header.payload ?? {});
    return payload.modelGuid === modelGuid && payload.skeletonGuid === current.header.guid;
  });
  const kind: SkeletonPayload["kind"] = currentPayload.kind === "skin" ? "skin" : targetPayload.kind;
  const skeletonChanges: Record<string, unknown> = {
    ...(match.changed ? { bones: match.bones } : {}),
    ...(kind !== targetPayload.kind ? { kind } : {}),
  };
  const edits: AssignSkeletonEdit[] = [
    { kind: "model", path: model.path, name: model.header.name, changes: { skeletonGuid: target.header.guid } },
    ...animations.map((asset): AssignSkeletonEdit => ({
      kind: "animation", path: asset.path, name: asset.header.name, changes: { skeletonGuid: target.header.guid },
    })),
    ...(Object.keys(skeletonChanges).length > 0
      ? [{ kind: "skeleton" as const, path: target.path, name: target.header.name, changes: skeletonChanges }]
      : []),
  ];
  const locked = edits.find((edit) => assets.find((asset) => asset.path === edit.path)?.readOnly);
  if (locked) return { error: `${locked.name} is read-only.` };
  return { edits };
}
