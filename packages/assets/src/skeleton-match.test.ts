import { describe, expect, it } from "vitest";
import {
  decomposeMatrix,
  findMatchingSkeleton,
  matchSkeletonBones,
  multiplyMatrices,
  trsMatrix,
} from "./skeleton-match";
import type { SkeletonBone, SkeletonPayload } from "./skeleton-payload";

function bone(name: string, parent: string | null, position: SkeletonBone["position"], extra: Partial<SkeletonBone> = {}): SkeletonBone {
  return { name, parent, position, rotation: [0, 0, 0, 1], scale: [1, 1, 1], ...extra };
}

/** A small biped: root, hips, spine and a leg. */
const BIPED: SkeletonBone[] = [
  bone("root", null, [0, 0, 0]),
  bone("hips", "root", [0, 1, 0]),
  bone("spine", "hips", [0, 0.3, 0]),
  bone("leg", "hips", [0.1, -0.1, 0], { rotation: [0, 0, 1, 0] }),
];

describe("matchSkeletonBones", () => {
  it("matches the same bones listed in another order", () => {
    expect(matchSkeletonBones(BIPED, [...BIPED].reverse())).toEqual({ relation: "same", bones: BIPED, changed: false });
  });

  it("joins a rig with some of the Skeleton's bones, and adds the extra bones of a larger one", () => {
    const head = bone("head", "spine", [0, 0.25, 0]);
    expect(matchSkeletonBones(BIPED, BIPED.slice(0, 3))).toMatchObject({ relation: "subset", changed: false });
    expect(matchSkeletonBones(BIPED, [...BIPED, head])).toEqual({ relation: "superset", bones: [...BIPED, head], changed: true });
  });

  it("refuses other parents, other proportions and a turned bone", () => {
    expect(matchSkeletonBones(BIPED, BIPED.map((entry) => entry.name === "leg" ? { ...entry, parent: "spine" } : entry))).toBeNull();
    // The same names at 2.5 times the size (KayKit's Rig_Large against Rig_Medium).
    expect(matchSkeletonBones(BIPED, BIPED.map((entry) => ({
      ...entry,
      position: entry.position.map((value) => value * 2.5) as SkeletonBone["position"],
    })))).toBeNull();
    expect(matchSkeletonBones(BIPED, BIPED.map((entry) => entry.name === "spine"
      ? { ...entry, rotation: [Math.sin(0.1), 0, 0, Math.cos(0.1)] as SkeletonBone["rotation"] }
      : entry))).toBeNull();
  });

  it("tolerates rounding in the rest pose", () => {
    const rounded = BIPED.map((entry) => ({ ...entry, position: entry.position.map((value) => value + 1e-5) as SkeletonBone["position"] }));
    expect(matchSkeletonBones(BIPED, rounded)?.relation).toBe("same");
  });

  it("needs two shared bones before a partial rig joins", () => {
    expect(matchSkeletonBones(BIPED, [bone("root", null, [0, 0, 0])])).toBeNull();
    expect(matchSkeletonBones(BIPED, [bone("other", null, [0, 0, 0]), bone("x", "other", [0, 1, 0])])).toBeNull();
  });

  it("ignores an armature root that only one side has", () => {
    const armature = bone("Armature", null, [0, 0, 0]);
    const withArmature = [armature, ...BIPED.map((entry) => entry.parent === null ? { ...entry, parent: "Armature" } : entry)];
    expect(matchSkeletonBones(BIPED, withArmature)).toEqual({ relation: "same", bones: BIPED, changed: false });
    expect(matchSkeletonBones(withArmature, BIPED)).toEqual({ relation: "same", bones: withArmature, changed: false });
    // An armature that moves the rig places its roots elsewhere.
    const lifted = [{ ...armature, position: [0, 2, 0] as SkeletonBone["position"] }, ...withArmature.slice(1)];
    expect(matchSkeletonBones(BIPED, lifted)).toBeNull();
  });

  it("ignores channels an animation library only has a pose for, and fills them from a Model's rest", () => {
    const posed = BIPED.map((entry) => entry.name === "spine"
      ? { ...entry, rotation: [0.3, 0, 0, 0.954] as SkeletonBone["rotation"], posed: ["rotation" as const] }
      : entry);
    expect(matchSkeletonBones(BIPED, posed)).toEqual({ relation: "same", bones: BIPED, changed: false });
    const filled = matchSkeletonBones(posed, BIPED);
    expect(filled?.changed).toBe(true);
    expect(filled?.bones.find((entry) => entry.name === "spine")).toEqual(BIPED[2]);
  });
});

describe("findMatchingSkeleton", () => {
  it("prefers the same bones over a Skeleton the rig would join or extend", () => {
    const skeleton = (guid: string, bones: SkeletonBone[]): { guid: string; payload: SkeletonPayload } =>
      ({ guid, payload: { modelGuid: "", kind: "skin", bones } });
    const candidates = [skeleton("larger", [...BIPED, bone("head", "spine", [0, 0.25, 0])]), skeleton("same", BIPED)];
    expect(findMatchingSkeleton(candidates, BIPED)?.skeleton.guid).toBe("same");
    expect(findMatchingSkeleton([candidates[0]!], BIPED)?.relation).toBe("subset");
    expect(findMatchingSkeleton([skeleton("other", [bone("a", null, [0, 0, 0]), bone("b", "a", [0, 1, 0])])], BIPED)).toBeNull();
  });
});

describe("matrix helpers", () => {
  it("compose and decompose translation, rotation and scale", () => {
    const parent = trsMatrix([1, 2, 3], [0, Math.SQRT1_2, 0, Math.SQRT1_2], [2, 2, 2]);
    const child = trsMatrix([1, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
    const { position, rotation, scale } = decomposeMatrix(multiplyMatrices(parent, child));
    // A quarter turn about Y sends +X to −Z; the parent's scale doubles the offset.
    expect(position.map((value) => Math.round(value * 1000) / 1000)).toEqual([1, 2, 1]);
    expect(rotation.map((value) => Math.round(value * 1000) / 1000)).toEqual([0, 0.707, 0, 0.707]);
    expect(scale.map((value) => Math.round(value * 1000) / 1000)).toEqual([2, 2, 2]);
  });

  it("reports a mirrored matrix with a negative X scale", () => {
    expect(decomposeMatrix(trsMatrix([0, 0, 0], [0, 0, 0, 1], [1, 1, -1])).scale[0]).toBeLessThan(0);
  });
});
