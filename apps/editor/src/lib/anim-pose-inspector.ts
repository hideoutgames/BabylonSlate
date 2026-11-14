import type { PropertyRow } from "@haptic/editor-kit";
import { assetRowIdentity } from "@haptic/editor-kit";
import {
  ANIM_FRAME_SELECT_BY_INT_TYPE,
  ANIM_POSE_BLEND_BY_BOOL_TYPE,
  ANIM_POSE_BLEND_BY_INT_TYPE,
  ANIM_FRAME_SPRITE_BLEND_SPACE_PLAYER_TYPE,
  ANIM_POSE_BLEND_SPACE_PLAYER_TYPE,
  isPoseAssetNodeType,
  isPoseTimeSourceType,
  isPosePlayerType,
} from "@haptic/anim-graph";
import { ANIM_POSE_MAX_INPUTS, animPoseInputCount } from "@haptic/scripting-nodes";

/** The asset pick a clip node's Animation row opens; the pick writes the node's clip, not a pin default. */
export const ANIM_POSE_CLIP_PICK = "__animClip";

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

/**
 * Settings stored on a pose node rather than on a pin: a player's or Sequence Evaluator's clip and Loop, a Blend
 * Poses By Bool's blend times, and a Blend Poses By Int's or Select Frame By Int's inputs and blend time.
 */
export function animPoseNodePropertyRows(
  typeId: string,
  data: Record<string, unknown>,
  onPatch: (patch: Record<string, unknown>) => void,
  options: {
    assetEntries: ReadonlyArray<{ id: string; name: string; type: string }>;
    onPickClip: (assetType: string) => void;
  },
): PropertyRow[] {
  const rows: PropertyRow[] = [];
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
