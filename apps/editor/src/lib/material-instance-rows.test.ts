import { describe, expect, it } from "vitest";
import { createDefaultMaterialInstanceDocument } from "@haptic/shader-graph";
import { materialInstanceParameterRows, setMaterialInstanceOverride, unusedMaterialInstanceOverrides } from "./material-instance-rows";

describe("material instance overrides", () => {
  it("clears an override when it is set back to the inherited value", () => {
    const inherited = { kind: "float", value: 0.5 } as const;
    const base = createDefaultMaterialInstanceDocument("Rock", "root");
    const overridden = setMaterialInstanceOverride(base, "Roughness", { kind: "float", value: 0.9 }, inherited);
    expect(overridden.overrides.Roughness).toEqual({ kind: "float", value: 0.9 });
    expect(setMaterialInstanceOverride(overridden, "Roughness", { kind: "float", value: 0.5 }, inherited).overrides).toEqual({});
    expect(setMaterialInstanceOverride(overridden, "Roughness", null, inherited).overrides).toEqual({});
  });

  it("reports overrides the root no longer exposes with the same kind", () => {
    const document = {
      ...createDefaultMaterialInstanceDocument("Rock", "root"),
      overrides: {
        Tint: { kind: "float", value: 1 },
        Roughness: { kind: "float", value: 0.2 },
        Gone: { kind: "float", value: 0 },
      },
    } as ReturnType<typeof createDefaultMaterialInstanceDocument>;
    expect(unusedMaterialInstanceOverrides(document, [
      { name: "Tint", inherited: { kind: "color", value: [1, 1, 1, 1] } },
      { name: "Roughness", inherited: { kind: "float", value: 0.5 } },
    ])).toEqual(["Gone", "Tint"]);
  });

  it("edits Vector2 and Vector3 parameters as vector rows of their width", () => {
    const document = { ...createDefaultMaterialInstanceDocument("Rock", "root"), overrides: { Tiling: { kind: "vec2", value: [3, 3] } } } as
      ReturnType<typeof createDefaultMaterialInstanceDocument>;
    const commits: ReturnType<typeof createDefaultMaterialInstanceDocument>[] = [];
    const rows = materialInstanceParameterRows(document, [
      { name: "Tiling", inherited: { kind: "vec2", value: [1, 1] } },
      { name: "Glow", inherited: { kind: "vec3", value: [0, 0.5, 1] } },
    ], { commit: (next) => commits.push(next), textureIdentity: () => ({}) as never, onPickTexture: () => undefined });
    const [tiling, glow] = rows as Array<Extract<(typeof rows)[number], { kind: "vector3" }>>;
    expect([tiling!.kind, tiling!.axes, tiling!.value, tiling!.status]).toEqual(["vector3", ["X", "Y"], [3, 3, 0], "Overridden"]);
    expect([glow!.axes, glow!.value]).toEqual([undefined, [0, 0.5, 1]]);
    glow!.onChange([1, 2, 3]);
    tiling!.onChange([1, 1, 0]);
    expect(commits[0]!.overrides.Glow).toEqual({ kind: "vec3", value: [1, 2, 3] });
    // Back to the inherited value clears the override.
    expect(commits[1]!.overrides).toEqual({});
  });
});
