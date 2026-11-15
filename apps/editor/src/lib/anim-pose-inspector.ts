import type { PropertyRow } from "@haptic/editor-kit";
import { assetRowIdentity } from "@haptic/editor-kit";
import {
  ANIM_SPRING_DEFAULTS,
  ANIM_SPRING_PLANAR_CONSTRAINTS,
  ANIM_SPRING_PLANAR_LABELS,
  normalizeAnimSpringBoneSettings,
  normalizeAnimFootPlacement,
  ANIM_BONE_AXES,
  ANIM_BONE_AXIS_LABELS,
  ANIM_BONE_MODIFY_MODE_LABELS,
  ANIM_BONE_MODIFY_MODES,
  ANIM_BONE_SPACE_LABELS,
  ANIM_BONE_SPACES,
  parseAnimBoneModifyMode,
  parseAnimBoneSpace,
  parseAnimTargetSpace,
} from "@haptic/core";
import {
  type AnimGraphDimension,
  ANIM_CONTROL_LOOK_AT_TYPE,
  ANIM_CONTROL_TRANSFORM_BONE_TYPE,
  ANIM_CONTROL_TWO_BONE_IK_TYPE,
  ANIM_CONTROL_SPRING_BONES_TYPE,
  ANIM_CONTROL_FOOT_PLACEMENT_TYPE,
  ANIM_POSE_LAYERED_BLEND_TYPE,
  isSkeletalControlType,
  ANIM_POSE_SAVE_CACHED_TYPE,
  ANIM_POSE_USE_CACHED_TYPE,
  isSlotNodeType,
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

const TARGET_SPACE_OPTIONS = [{ value: "actor", label: "Actor Space" }, { value: "world", label: "World Space" }];
const AXIS_OPTIONS = ANIM_BONE_AXES.map((value) => ({ value, label: ANIM_BONE_AXIS_LABELS[value] }));

/** Where an IK target pin's value is: relative to the actor, or in the world. */
function targetSpaceRow(key: string, label: string, data: Record<string, unknown>, onPatch: (patch: Record<string, unknown>) => void): PropertyRow {
  return {
    kind: "enum",
    id: key,
    label,
    value: parseAnimTargetSpace(data[key]),
    defaultValue: "actor",
    options: TARGET_SPACE_OPTIONS,
    onChange: (value) => onPatch({ [key]: value }),
  };
}

function axisValue(value: unknown, fallback: string): string {
  return ANIM_BONE_AXES.find((axis) => axis === value) ?? fallback;
}

/** Look At's rows after its bone: the target's space, the axes it aims and keeps up, its limit and easing. */
function lookAtRows(data: Record<string, unknown>, onPatch: (patch: Record<string, unknown>) => void): PropertyRow[] {
  const number = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
  return [
    targetSpaceRow("targetSpace", "Target Space", data, onPatch),
    { kind: "enum", id: "aimAxis", label: "Aim Axis", value: axisValue(data.aimAxis, "z"), defaultValue: "z", options: AXIS_OPTIONS, onChange: (aimAxis) => onPatch({ aimAxis }) },
    {
      kind: "enum",
      id: "upAxis",
      label: "Up Axis",
      value: data.upAxis === undefined || data.upAxis === "none" ? "none" : axisValue(data.upAxis, "none"),
      defaultValue: "none",
      options: [{ value: "none", label: "None" }, ...AXIS_OPTIONS],
      description: "Rolls the bone about its aim so this axis leans toward the actor's up.",
      onChange: (upAxis) => onPatch({ upAxis }),
    },
    {
      kind: "number",
      id: "limitDegrees",
      label: "Angle Limit",
      unit: "°",
      min: 0,
      max: 180,
      value: number(data.limitDegrees, 180),
      defaultValue: 180,
      onChange: (limitDegrees) => onPatch({ limitDegrees }),
    },
    {
      kind: "number",
      id: "interpSeconds",
      label: "Interpolation Time",
      unit: "s",
      min: 0,
      value: number(data.interpSeconds, 0),
      defaultValue: 0,
      description: "How long the bone takes to follow a target that jumps; 0 follows at once.",
      onChange: (interpSeconds) => onPatch({ interpSeconds }),
    },
  ];
}

/** Two Bone IK's rows after its bone: the effector's space, the Joint Target, stretch and the end bone's rotation. */
function twoBoneIkRows(data: Record<string, unknown>, onPatch: (patch: Record<string, unknown>) => void): PropertyRow[] {
  const useJointTarget = data.useJointTarget === true;
  return [
    targetSpaceRow("effectorSpace", "Effector Space", data, onPatch),
    {
      kind: "boolean",
      id: "useJointTarget",
      label: "Use Joint Target",
      value: useJointTarget,
      description: "Bends the joint toward Joint Target; off, it bends the way the pose bends it.",
      onChange: (next) => onPatch({ useJointTarget: next }),
    },
    ...(useJointTarget ? [targetSpaceRow("jointTargetSpace", "Joint Target Space", data, onPatch)] : []),
    {
      kind: "number",
      id: "maxStretch",
      label: "Max Stretch",
      min: 1,
      value: typeof data.maxStretch === "number" && Number.isFinite(data.maxStretch) ? Math.max(1, data.maxStretch) : 1,
      defaultValue: 1,
      description: "How far the limb may lengthen to reach an effector out of reach, as a multiple of its length; 1 never stretches.",
      onChange: (maxStretch) => onPatch({ maxStretch: Math.max(1, maxStretch) }),
    },
    {
      kind: "boolean",
      id: "keepEffectorRotation",
      label: "Keep Effector Rotation",
      value: data.keepEffectorRotation === true,
      description: "Keeps the end bone's rotation relative to the actor, so a foot stays level as the leg bends.",
      onChange: (next) => onPatch({ keepEffectorRotation: next }),
    },
  ];
}

/** A multiplier curve along a Spring Bones chain; its default leaves the setting as it is everywhere. */
const FLAT_CHAIN_CURVE = [{ t: 0, value: 1 }, { t: 1, value: 1 }];

/**
 * Spring Bones' rows after its Root Bone: the spring, World Damping, forces, collision, limits, the curves along the
 * chain, and its constraint and resets. Exclude Bones and the colliders are lists of their own
 * (`SpringBonesLists`).
 */
function springBonesRows(data: Record<string, unknown>, onPatch: (patch: Record<string, unknown>) => void): PropertyRow[] {
  const settings = normalizeAnimSpringBoneSettings(data);
  const d = ANIM_SPRING_DEFAULTS;
  const fraction = (key: "stiffness" | "damping" | "worldDampingLocation" | "worldDampingRotation", label: string, description?: string): PropertyRow => ({
    kind: "number", id: key, label, min: 0, max: 1, value: settings[key], defaultValue: d[key], ...(description ? { description } : {}),
    onChange: (value) => onPatch({ [key]: Math.min(1, Math.max(0, value)) }),
  });
  const distance = (key: "radius" | "teleportDistance" | "tipLength" | "windStrength", label: string, unit: string, description?: string): PropertyRow => ({
    kind: "number", id: key, label, unit, min: 0, value: settings[key], defaultValue: d[key], ...(description ? { description } : {}),
    onChange: (value) => onPatch({ [key]: Math.max(0, value) }),
  });
  const angle = (key: "limitDegrees" | "teleportDegrees", label: string, description?: string): PropertyRow => ({
    kind: "number", id: key, label, unit: "°", min: 0, max: 180, value: settings[key], defaultValue: d[key], ...(description ? { description } : {}),
    onChange: (value) => onPatch({ [key]: Math.min(180, Math.max(0, value)) }),
  });
  const vector = (key: "gravity" | "windDirection", label: string, description?: string): PropertyRow => ({
    kind: "vector3", id: key, label, value: settings[key] as [number, number, number], defaultValue: d[key] as [number, number, number],
    ...(description ? { description } : {}),
    onChange: (value) => onPatch({ [key]: [value[0], value[1], value[2]] }),
  });
  const curve = (key: "stiffnessCurve" | "dampingCurve" | "radiusCurve" | "limitAngleCurve", label: string): PropertyRow => {
    const keys = Array.isArray(data[key]) && (data[key] as unknown[]).length > 0
      ? (settings.curves[key.replace("Curve", "") as keyof typeof settings.curves])
      : FLAT_CHAIN_CURVE;
    return {
      kind: "curve", id: key, label, value: keys, defaultValue: FLAT_CHAIN_CURVE, valueMin: 0,
      axisLabels: { start: "Root", end: "Tip" }, minKeys: 2, maxKeys: 8,
      onChange: (next) => onPatch({ [key]: next.map((entry) => ({ t: entry.t, value: entry.value })) }),
    };
  };
  return [
    fraction("stiffness", "Stiffness", "How strongly each bone returns to its pose every 1/120 s."),
    fraction("damping", "Damping"),
    fraction("worldDampingLocation", "World Damping Location", "How much of the actor's movement the chain ignores; 0 lets it trail fully."),
    fraction("worldDampingRotation", "World Damping Rotation", "How much of the actor's turning the chain ignores; 0 lets it swing fully."),
    vector("gravity", "Gravity", "A world-space acceleration, such as 0, -9.8, 0."),
    vector("windDirection", "Wind Direction"),
    distance("windStrength", "Wind Strength", "m/s²"),
    { kind: "number", id: "windSeed", label: "Wind Seed", value: settings.windSeed, defaultValue: d.windSeed, precision: 0, sensitivity: 0.1,
      description: "Shapes the wind's gusts; chains with the same seed gust together.", onChange: (value) => onPatch({ windSeed: Math.round(value) }) },
    distance("radius", "Radius", "m", "Each bone's collision radius against the colliders."),
    angle("limitDegrees", "Limit Angle", "The furthest a bone turns from its pose; 0 is no limit."),
    curve("stiffnessCurve", "Stiffness Curve"),
    curve("dampingCurve", "Damping Curve"),
    curve("radiusCurve", "Radius Curve"),
    curve("limitAngleCurve", "Limit Angle Curve"),
    {
      kind: "enum", id: "planarConstraint", label: "Planar Constraint", value: settings.planarConstraint, defaultValue: "none",
      options: ANIM_SPRING_PLANAR_CONSTRAINTS.map((value) => ({ value, label: ANIM_SPRING_PLANAR_LABELS[value] })),
      description: "Keeps the chain from moving along one of the actor's axes.",
      onChange: (planarConstraint) => onPatch({ planarConstraint }),
    },
    distance("teleportDistance", "Teleport Distance", "m", "A move of the actor further than this in one tick resets the chain to its pose; 0 never resets."),
    angle("teleportDegrees", "Teleport Angle", "A turn of the actor further than this in one tick resets the chain; 0 never resets."),
    distance("tipLength", "Tip Length", "m", "Adds a tip past each last bone, so that bone swings too."),
  ];
}

/** Foot Placement's rows (its Feet are a list of their own, `FootPlacementFeet`). */
function footPlacementRows(data: Record<string, unknown>, bones: readonly string[], onPatch: (patch: Record<string, unknown>) => void): PropertyRow[] {
  const settings = normalizeAnimFootPlacement(data);
  const pelvis = settings.pelvisBone ?? "";
  return [
    {
      kind: "enum",
      id: "pelvisBone",
      label: "Pelvis Bone",
      value: pelvis,
      options: [{ value: "", label: "None" }, ...nameOptions(bones, pelvis)],
      verbatim: true,
      description: "Drops by as much as the lowest foot, so that leg can reach lower ground.",
      onChange: (next) => onPatch({ pelvisBone: next || undefined }),
    },
    {
      kind: "number", id: "traceUp", label: "Trace Up", unit: "m", min: 0, value: settings.traceUp, defaultValue: 0.5,
      description: "How far above each foot its trace for the ground starts.",
      onChange: (traceUp) => onPatch({ traceUp: Math.max(0, traceUp) }),
    },
    {
      kind: "number", id: "traceDown", label: "Trace Down", unit: "m", min: 0, value: settings.traceDown, defaultValue: 0.5,
      description: "How far below each foot its trace looks for ground.",
      onChange: (traceDown) => onPatch({ traceDown: Math.max(0, traceDown) }),
    },
    {
      kind: "boolean", id: "alignToGround", label: "Align To Ground", value: settings.alignToGround,
      onChange: (alignToGround) => onPatch({ alignToGround }),
    },
  ];
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
 * Per Bone's inputs, a cached pose's name, a Transform Bone's bone and channel modes and spaces, and a Look At's or
 * Two Bone IK's bone, spaces and settings.
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
  if (isSlotNodeType(typeId)) {
    rows.push({
      kind: "text",
      id: "slotName",
      label: "Slot Name",
      value: typeof data.slotName === "string" && data.slotName ? data.slotName : "DefaultSlot",
      defaultValue: "DefaultSlot",
      onChange: (slotName) => onPatch({ slotName: slotName.trim() || "DefaultSlot" }),
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
  if (isSkeletalControlType(typeId) && typeId !== ANIM_CONTROL_FOOT_PLACEMENT_TYPE) {
    const bone = typeof data.bone === "string" ? data.bone : "";
    const bones = options.bones ?? [];
    const ik = typeId === ANIM_CONTROL_TWO_BONE_IK_TYPE;
    const springs = typeId === ANIM_CONTROL_SPRING_BONES_TYPE;
    const label = ik ? "End Bone" : springs ? "Root Bone" : "Bone";
    const description = ik
      ? "The hand or foot that reaches the effector; its parent and grandparent turn."
      : springs ? "Every bone below it simulates; it stays posed and turns to follow its children." : undefined;
    rows.push(bones.length > 0
      ? { kind: "enum", id: "bone", label, value: bone, options: nameOptions(bones, bone), verbatim: true, ...(description ? { description } : {}), onChange: (next) => onPatch({ bone: next }) }
      : { kind: "text", id: "bone", label, value: bone, ...(description ? { description } : {}), onChange: (next) => onPatch({ bone: next.trim() }) });
  }
  if (typeId === ANIM_CONTROL_TRANSFORM_BONE_TYPE) {
    rows.push(
      ...boneChannelRows("translation", "Translation", data, onPatch),
      ...boneChannelRows("rotation", "Rotation", data, onPatch),
      ...boneChannelRows("scale", "Scale", data, onPatch),
    );
  }
  if (typeId === ANIM_CONTROL_LOOK_AT_TYPE) rows.push(...lookAtRows(data, onPatch));
  if (typeId === ANIM_CONTROL_TWO_BONE_IK_TYPE) rows.push(...twoBoneIkRows(data, onPatch));
  if (typeId === ANIM_CONTROL_SPRING_BONES_TYPE) rows.push(...springBonesRows(data, onPatch));
  if (typeId === ANIM_CONTROL_FOOT_PLACEMENT_TYPE) rows.push(...footPlacementRows(data, options.bones ?? [], onPatch));
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
