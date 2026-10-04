import { describe, expect, it } from "vitest";
import { createDefaultMaterialInstanceDocument } from "@babylonslate/shader-graph";
import { setMaterialInstanceOverride, unusedMaterialInstanceOverrides } from "./material-instance-rows";

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
});
