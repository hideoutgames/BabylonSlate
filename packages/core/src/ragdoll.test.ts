import { describe, expect, it } from "vitest";
import { parseRagdollProperties } from "./ragdoll";

describe("ragdoll authoring properties", () => {
  it("owns bone selections and rejects ambiguous selections or unsafe physics tuning", () => {
    const names = ["Hips", "Spine"];
    const properties = parseRagdollProperties({ boneNames: names, layer: 0x80000000 });
    names.push("Head");
    expect(properties.boneNames).toEqual(["Hips", "Spine"]);
    expect(properties.layer).toBe(2147483648);
    for (const invalid of [
      { boneNames: ["Hips", "Hips"] }, { boneNames: [""] }, { radius: 0 },
      { totalMass: NaN }, { angularLimit: 181 }, { mask: 1.5 }, { restitution: 2 },
    ]) expect(() => parseRagdollProperties(invalid)).toThrow();
  });
});
