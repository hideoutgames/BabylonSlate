/**
 * Per-bone pose data an Animation Graph evaluation hands render (the `animState` command): the branch filters and
 * weights of each Layered Blend Per Bone it reached, and the bone changes its Transform Bone nodes made. Render
 * resolves bone names against the posed Model's nodes.
 */

/**
 * One branch of a Layered Blend Per Bone input: the bone it starts at and how its weight ramps in down the branch.
 * Blend Depth 0 takes the bone and every bone below it fully; N > 0 ramps in over N bones (the bone at 1/N, the Nth
 * below it at full weight); below 0 leaves the branch out of an enclosing one.
 */
export interface AnimBranchFilter {
  bone: string;
  blendDepth: number;
}

/** A Layered Blend Per Bone input's branch filters as stored on the node, cleaned: named bones, whole depths. */
export function normalizeAnimBranchFilters(value: unknown): AnimBranchFilter[] {
  if (!Array.isArray(value)) return [];
  const branches: AnimBranchFilter[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const bone = typeof row.bone === "string" ? row.bone : "";
    const depth = typeof row.blendDepth === "number" && Number.isFinite(row.blendDepth) ? Math.round(row.blendDepth) : 0;
    branches.push({ bone, blendDepth: depth });
  }
  return branches;
}

/** Branch filters as one string, which keys render's per-bone weights for them. */
export function animBranchFilterKey(branches: readonly AnimBranchFilter[]): string {
  return JSON.stringify(branches.filter((branch) => branch.bone).map((branch) => [branch.bone, branch.blendDepth]));
}

/** The branch filters an `animBranchFilterKey` holds, as a map from bone to Blend Depth. */
export function parseAnimBranchFilterKey(key: string): Map<string, number> {
  const branches = new Map<string, number>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(key);
  } catch {
    return branches;
  }
  if (!Array.isArray(parsed)) return branches;
  for (const entry of parsed) {
    if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "number" && !branches.has(entry[0])) {
      branches.set(entry[0], entry[1]);
    }
  }
  return branches;
}

/**
 * A bone's weight under branch filters, from its chain of names (the bone's own first, then each parent's): the
 * nearest branch up the chain decides. 0 outside every branch.
 */
export function animBranchWeight(branches: ReadonlyMap<string, number>, chain: readonly string[]): number {
  for (let depth = 0; depth < chain.length; depth++) {
    const blendDepth = branches.get(chain[depth]!);
    if (blendDepth === undefined) continue;
    if (blendDepth < 0) return 0;
    return blendDepth === 0 ? 1 : Math.min(1, (depth + 1) / blendDepth);
  }
  return 0;
}

/**
 * A Layered Blend Per Bone an evaluation reached: each blend input's branch filters (`animBranchFilterKey`) and
 * Blend Weight. Per bone, input i takes weight × its branch weight; above a total of 1 the inputs share 1, and the
 * Base Pose takes what they leave.
 */
export interface AnimLayerBlend {
  filters: string[];
  weights: number[];
}

/**
 * Where a clip layer or bone change sits under a Layered Blend Per Bone: the blend (its index in the evaluation's
 * `layerBlends`) and its input there, -1 for the Base Pose. A list holds the enclosing blends, outermost first.
 */
export interface AnimLayerMaskRef {
  blend: number;
  input: number;
}

/** The space a Transform Bone channel works in: the actor's, the bone's parent's, or the bone's own axes. */
export const ANIM_BONE_SPACES = ["actor", "parent", "bone"] as const;
export type AnimBoneSpace = (typeof ANIM_BONE_SPACES)[number];
export const ANIM_BONE_SPACE_LABELS: Record<AnimBoneSpace, string> = {
  actor: "Actor Space",
  parent: "Parent Space",
  bone: "Bone Space",
};

/** What a Transform Bone channel does: nothing, set the value, or add it to the pose's. */
export const ANIM_BONE_MODIFY_MODES = ["ignore", "replace", "add"] as const;
export type AnimBoneModifyMode = (typeof ANIM_BONE_MODIFY_MODES)[number];
export const ANIM_BONE_MODIFY_MODE_LABELS: Record<AnimBoneModifyMode, string> = {
  ignore: "Ignore",
  replace: "Replace Existing",
  add: "Add To Existing",
};

export function parseAnimBoneSpace(value: unknown): AnimBoneSpace {
  return ANIM_BONE_SPACES.find((space) => space === value) ?? "actor";
}

export function parseAnimBoneModifyMode(value: unknown): AnimBoneModifyMode {
  return ANIM_BONE_MODIFY_MODES.find((mode) => mode === value) ?? "ignore";
}

/** One channel of a bone change: its value (a vector, or a quaternion for rotation), how it applies and where. */
export interface AnimBoneChannel {
  value: number[];
  mode: Exclude<AnimBoneModifyMode, "ignore">;
  space: AnimBoneSpace;
}

/**
 * A Transform Bone's change to one bone, applied after the clips blend and in evaluation order: scale, then rotation,
 * then translation, each in its own space, then blended with the pose by `alpha` (the node's Alpha times its weight
 * in the graph). A channel left out is unchanged.
 */
export interface AnimBoneModifier {
  bone: string;
  alpha: number;
  translation?: AnimBoneChannel;
  rotation?: AnimBoneChannel;
  scale?: AnimBoneChannel;
  masks?: AnimLayerMaskRef[];
}

/**
 * The pose an additive clip layer is a change from, when not the Skeleton's rest pose: a clip (the layer's own, for an
 * Animation additive to its first frame) at a normalised time.
 */
export interface AnimAdditiveBase {
  clipAssetGuid: string;
  clipName: string;
  normalisedTime: number;
}
