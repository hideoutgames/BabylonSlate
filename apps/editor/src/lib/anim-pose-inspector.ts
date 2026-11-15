import type { PropertyRow } from "@haptic/editor-kit";
import { assetRowIdentity } from "@haptic/editor-kit";
import {
  ANIM_BONE_MODIFY_MODE_LABELS,
  ANIM_BONE_MODIFY_MODES,
  ANIM_BONE_SPACE_LABELS,
  ANIM_BONE_SPACES,
  parseAnimBoneModifyMode,
  parseAnimBoneSpace,
} from "@haptic/core";
import {
  type AnimGraphDimension,
  ANIM_CONTROL_TRANSFORM_BONE_TYPE,
  ANIM_POSE_LAYERED_BLEND_TYPE,
  ANIM_POSE_SAVE_CACHED_TYPE,
  ANIM_POSE_USE_CACHED_TYPE,
  layeredBlendInputCount,
  ANIM_FRAME_SELECT_BY_INT_TYPE,
  ANIM_POSE_BLEND_BY_BOOL_TYPE,
  ANIM_POSE_BLEND_BY_INT_TYPE,
  ANIM_FRAME_SPRITE_BLEND_SPACE_PLAYER_TYPE,
  ANIM_POSE_BLEND_SPACE_PLAYER_TYPE,
  isPoseAssetNodeType,
  isPoseTimeSourceType,
  isPosePlayerType,
} from "@haptic/anim-graph";
import { normalizeAnimationPayload, normalizeBlendSpacePayload } from "@haptic/assets";
import { ANIM_POSE_MAX_INPUTS, animPoseInputCount } from "@haptic/scripting-nodes";

/** The asset pick a clip node's Animation row opens; the pick writes the node's clip, not a pin default. */
export const ANIM_POSE_CLIP_PICK = "__animClip";

/**
 * The Animation Graph a state graph's node is in: what decides which assets a clip pick can play, and the cached
 * poses its Use Cached Pose nodes can name.
 */
export type AnimClipPickGraph = { dimension: AnimGraphDimension; skeletonGuid: string | null; cachedPoses?: readonly string[] };

/**
 * Whether `asset` can play in `graph`, by the rule validation applies (`anim.clipKind`, `anim.clipSkeleton`): a 3D
 * graph plays Animations and Blend Spaces on its own Skeleton (no Skeleton matches assets with none), a 2D graph
 * Sprite Animations and Sprite Blend Spaces.
 */
export function animGraphPlaysAsset(asset: { type: string; payload?: unknown }, graph: AnimClipPickGraph): boolean {
  switch (asset.type) {
    case "Animation":
      return graph.dimension === "3d" && normalizeAnimationPayload(asset.payload ?? {}).skeletonGuid === graph.skeletonGuid;
    case "BlendSpace":
      return graph.dimension === "3d" && normalizeBlendSpacePayload(asset.payload ?? {}).skeletonGuid === graph.skeletonGuid;
    case "SpriteAnimation":
    case "SpriteBlendSpace":
      return graph.dimension === "2d";
    default:
      return false;
  }
}

/** The node data a picked clip or Blend Space writes: its asset, with what the catalog fills in again cleared. */
export function animPoseClipPatch(guid: string | null): Record<string, unknown> {
  return { assetGuid: guid ?? "", clipName: undefined, durationMs: undefined, frameCount: undefined, blendSpace: undefined };
}

/** A looping player's Sync Group, by name: players in one group share their cycles' position. Empty for none. */
export function animSyncGroupRow(value: unknown, onChange: (syncGroup: string | undefined) => void): PropertyRow {
  return {
    kind: "text",
    id: "animPoseSyncGroup",
    label: "Sync Group",
    value: typeof value === "string" ? value : "",
    description: "Looping players with the same Sync Group play at the same point of their cycles, so a walk blending into a run keeps its stride.",
    onChange: (next) => onChange(next.trim() ? next.trim() : undefined),
  };
}

/** The asset type and row label a pose node's asset row picks. */
function poseAssetKind(typeId: string): { assetType: string; label: string } {
  if (typeId === ANIM_POSE_BLEND_SPACE_PLAYER_TYPE) return { assetType: "BlendSpace", label: "Blend Space" };
  if (typeId === ANIM_FRAME_SPRITE_BLEND_SPACE_PLAYER_TYPE) return { assetType: "SpriteBlendSpace", label: "Sprite Blend Space" };
  return typeId.startsWith("anim.frame.")
    ? { assetType: "SpriteAnimation", label: "Sprite Animation" }
    : { assetType: "Animation", label: "Animation" };
}

/** A name row's options: `names`, with the current value kept when it is not among them. */
function nameOptions(names: readonly string[], current: string): Array<{ value: string; label: string }> {
  const listed = current && !names.includes(current) ? [current, ...names] : names;
  return listed.map((name) => ({ value: name, label: name }));
}

/** Transform Bone's mode and space rows for one channel; the space shows only while the channel changes the bone. */
function boneChannelRows(
  channel: "translation" | "rotation" | "scale",
  label: string,
  data: Record<string, unknown>,
  onPatch: (patch: Record<string, unknown>) => void,
): PropertyRow[] {
  const mode = parseAnimBoneModifyMode(data[`${channel}Mode`]);
  const rows: PropertyRow[] = [{
    kind: "enum",
    id: `${channel}Mode`,
    label: `${label} Mode`,
    value: mode,
    defaultValue: "ignore",
    options: ANIM_BONE_MODIFY_MODES.map((value) => ({ value, label: ANIM_BONE_MODIFY_MODE_LABELS[value] })),
    onChange: (value) => onPatch({ [`${channel}Mode`]: value }),
  }];
  if (mode !== "ignore") {
    rows.push({
      kind: "enum",
      id: `${channel}Space`,
      label: `${label} Space`,
      value: parseAnimBoneSpace(data[`${channel}Space`]),
      defaultValue: "actor",
      options: ANIM_BONE_SPACES.map((value) => ({ value, label: ANIM_BONE_SPACE_LABELS[value] })),
      onChange: (value) => onPatch({ [`${channel}Space`]: value }),
    });
  }
  return rows;
}

/**
 * Settings stored on a pose node rather than on a pin: a player's or Sequence Evaluator's clip and Loop, a Blend
 * Poses By Bool's blend times, a Blend Poses By Int's or Select Frame By Int's inputs and blend time, a Layered Blend
 * Per Bone's inputs, a cached pose's name, and a Transform Bone's bone and channel modes and spaces.
 */
export function animPoseNodePropertyRows(
  typeId: string,
  data: Record<string, unknown>,
  onPatch: (patch: Record<string, unknown>) => void,
  options: {
    assetEntries: ReadonlyArray<{ id: string; name: string; type: string }>;
    onPickClip: (assetType: string) => void;
    /** The graph's Skeleton's bones, which a Transform Bone picks from. */
    bones?: readonly string[];
    /** The graph's saved cached poses, which a Use Cached Pose picks from. */
    cachedPoses?: readonly string[];
  },
): PropertyRow[] {
  const rows: PropertyRow[] = [];
  if (typeId === ANIM_POSE_LAYERED_BLEND_TYPE) {
    rows.push({
      kind: "number",
      id: "count",
      label: "Blend Poses",
      value: layeredBlendInputCount(data.count),
      defaultValue: 1,
      min: 1,
      max: ANIM_POSE_MAX_INPUTS,
      precision: 0,
      sensitivity: 0.1,
      onChange: (value) => onPatch({ count: layeredBlendInputCount(value) }),
    });
  }
  if (typeId === ANIM_POSE_SAVE_CACHED_TYPE) {
    rows.push({
      kind: "text",
      id: "cachedPoseName",
      label: "Name",
      value: typeof data.name === "string" ? data.name : "",
      onChange: (name) => onPatch({ name: name.trim() }),
    });
  }
  if (typeId === ANIM_POSE_USE_CACHED_TYPE) {
    const current = typeof data.name === "string" ? data.name : "";
    rows.push({
      kind: "enum",
      id: "cachedPoseName",
      label: "Cached Pose",
      value: current,
      options: nameOptions(options.cachedPoses ?? [], current),
      verbatim: true,
      onChange: (name) => onPatch({ name }),
    });
  }
  if (typeId === ANIM_CONTROL_TRANSFORM_BONE_TYPE) {
    const bone = typeof data.bone === "string" ? data.bone : "";
    const bones = options.bones ?? [];
    rows.push(bones.length > 0
      ? { kind: "enum", id: "bone", label: "Bone", value: bone, options: nameOptions(bones, bone), verbatim: true, onChange: (next) => onPatch({ bone: next }) }
      : { kind: "text", id: "bone", label: "Bone", value: bone, onChange: (next) => onPatch({ bone: next.trim() }) });
    rows.push(
      ...boneChannelRows("translation", "Translation", data, onPatch),
      ...boneChannelRows("rotation", "Rotation", data, onPatch),
      ...boneChannelRows("scale", "Scale", data, onPatch),
    );
  }
  if (isPoseAssetNodeType(typeId)) {
    const { assetType, label } = poseAssetKind(typeId);
    const assetGuid = typeof data.assetGuid === "string" ? data.assetGuid : "";
    const listed = options.assetEntries.find((entry) => entry.id === assetGuid);
    rows.push({
      kind: "asset",
      id: "animPoseClip",
      label,
      value: assetGuid || null,
      placeholder: "None",
      assetTypes: [assetType],
      onPick: () => options.onPickClip(assetType),
      onChange: (value) => onPatch(animPoseClipPatch(value)),
      ...assetRowIdentity(listed ? { name: listed.name, type: listed.type } : assetGuid ? { name: assetGuid, type: assetType } : undefined),
    });
  }
  if (isPosePlayerType(typeId)) {
    rows.push({ kind: "boolean", id: "animPoseLoop", label: "Loop", value: data.loop !== false, onChange: (loop) => onPatch({ loop }) });
  }
  if (isPoseTimeSourceType(typeId)) rows.push(animSyncGroupRow(data.syncGroup, (syncGroup) => onPatch({ syncGroup })));
  if (typeId === ANIM_POSE_BLEND_BY_BOOL_TYPE) {
    for (const [key, label] of [["trueBlendSeconds", "True Blend Time"], ["falseBlendSeconds", "False Blend Time"]] as const) {
      rows.push({
        kind: "number",
        id: key,
        label,
        unit: "s",
        min: 0,
        value: typeof data[key] === "number" ? data[key] as number : 0.2,
        defaultValue: 0.2,
        onChange: (value) => onPatch({ [key]: value }),
      });
    }
  }
  if (typeId === ANIM_POSE_BLEND_BY_INT_TYPE || typeId === ANIM_FRAME_SELECT_BY_INT_TYPE) {
    rows.push({
      kind: "number",
      id: "count",
      label: typeId === ANIM_POSE_BLEND_BY_INT_TYPE ? "Poses" : "Frames",
      value: animPoseInputCount(data),
      defaultValue: 2,
      min: 2,
      max: ANIM_POSE_MAX_INPUTS,
      precision: 0,
      sensitivity: 0.1,
      onChange: (value) => onPatch({ count: animPoseInputCount({ count: value }) }),
    });
  }
  if (typeId === ANIM_POSE_BLEND_BY_INT_TYPE) {
    rows.push({
      kind: "number",
      id: "blendSeconds",
      label: "Blend Time",
      unit: "s",
      min: 0,
      value: typeof data.blendSeconds === "number" ? data.blendSeconds : 0.2,
      defaultValue: 0.2,
      onChange: (blendSeconds) => onPatch({ blendSeconds }),
    });
  }
  return rows;
}
