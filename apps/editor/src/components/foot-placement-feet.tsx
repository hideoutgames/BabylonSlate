import { normalizeAnimFootPlacement } from "@haptic/core";
import { BoneNameList } from "./bone-name-list";

/** Foot Placement's feet: each the end bone (foot or ankle) of a two-bone leg, picked from the graph's Skeleton. */
export function FootPlacementFeet({
  data,
  bones,
  onPatch,
}: {
  data: Record<string, unknown>;
  bones: readonly string[];
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  return (
    <BoneNameList
      title="Feet"
      hint="Each foot's leg is its parent and grandparent: Two Bone IK bends them."
      addLabel="Add Foot"
      value={normalizeAnimFootPlacement(data).feet}
      bones={bones}
      onChange={(feet) => onPatch({ feet })}
      testId="foot-placement-feet"
    />
  );
}
