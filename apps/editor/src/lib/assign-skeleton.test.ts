import { describe, expect, it } from "vitest";
import { assignableSkeletons, planAssignSkeleton, type AssignSkeletonAsset } from "./assign-skeleton";

const bone = (name: string, parent: string | null, y: number) =>
  ({ name, parent, position: [0, y, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const MEDIUM = [bone("root", null, 0), bone("hips", "root", 1), bone("spine", "hips", 0.3)];

function skeleton(guid: string, bones: unknown[], readOnly = false): AssignSkeletonAsset {
  return { path: `assets/${guid}.hasset`, readOnly, header: { guid, type: "Skeleton", name: guid, payload: { modelGuid: "", kind: "skin", bones } } };
}
function asset(guid: string, type: string, payload: Record<string, unknown>): AssignSkeletonAsset {
  return { path: `assets/${guid}.hasset`, header: { guid, type, name: guid, payload } };
}

const ASSETS = [
  skeleton("knight-rig", MEDIUM),
  skeleton("rogue-rig", [...MEDIUM].reverse()),
  skeleton("large-rig", MEDIUM.map((entry) => ({ ...entry, position: [0, entry.position[1]! * 2.5, 0] }))),
  asset("rogue", "Model", { materialSlots: [], skeletonGuid: "rogue-rig" }),
  asset("rogue-walk", "Animation", { clipName: "Walk", modelGuid: "rogue", skeletonGuid: "rogue-rig" }),
  asset("rogue-idle", "Animation", { clipName: "Idle", modelGuid: "rogue", skeletonGuid: "rogue-rig", sourceAnimationGuid: "x" }),
  asset("other-walk", "Animation", { clipName: "Walk", modelGuid: "other", skeletonGuid: "rogue-rig" }),
];

describe("Assign Skeleton", () => {
  it("offers only other Skeletons with the same bones", () => {
    expect(assignableSkeletons(ASSETS, "rogue").map((entry) => entry.header.guid)).toEqual(["knight-rig"]);
  });

  it("moves the Model and its own and retargeted Animations, leaving other Models' Animations", () => {
    expect(planAssignSkeleton(ASSETS, "rogue", "knight-rig")).toEqual({
      edits: [
        { kind: "model", path: "assets/rogue.hasset", name: "rogue", changes: { skeletonGuid: "knight-rig" } },
        { kind: "animation", path: "assets/rogue-walk.hasset", name: "rogue-walk", changes: { skeletonGuid: "knight-rig" } },
        { kind: "animation", path: "assets/rogue-idle.hasset", name: "rogue-idle", changes: { skeletonGuid: "knight-rig" } },
      ],
    });
  });

  it("adds the Model's extra bones to the target Skeleton", () => {
    const assets = [skeleton("small-rig", MEDIUM.slice(0, 2)), ...ASSETS];
    const plan = planAssignSkeleton(assets, "rogue", "small-rig");
    expect("edits" in plan && plan.edits.at(-1)).toMatchObject({ kind: "skeleton", changes: { bones: MEDIUM } });
  });

  it("refuses a Skeleton whose bones differ, and a read-only target", () => {
    expect(planAssignSkeleton(ASSETS, "rogue", "large-rig")).toEqual({ error: "The bones of large-rig differ from rogue-rig's." });
    const assets = [skeleton("small-rig", MEDIUM.slice(0, 2), true), ...ASSETS];
    expect(planAssignSkeleton(assets, "rogue", "small-rig")).toEqual({ error: "small-rig is read-only." });
  });
});
