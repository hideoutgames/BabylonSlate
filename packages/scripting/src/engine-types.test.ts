import { describe, expect, it } from "vitest";
import { parseText2DAppearProperties, text2DCharacterReveal } from "@haptic/core";
import { mergeEngineTypeSchemas } from "./type-defaults";
import {
  ENGINE_STRUCTS,
  customEasingCurveEnumLabel,
  isCustomEasingCurveEnumValue,
} from "./engine-types";

describe("engine type registry", () => {
  it("accepts a custom easing curve as a value of exactly the three curve enums, and labels it there only", () => {
    for (const enumId of ["engine:EasingCurve", "engine:CurveInterpolation", "engine:Text2DAppearTransition"]) {
      expect(isCustomEasingCurveEnumValue(enumId, "class:Snap"), enumId).toBe(true);
      expect(isCustomEasingCurveEnumValue(enumId, "class:"), enumId).toBe(false);
      expect(isCustomEasingCurveEnumValue(enumId, "quadIn"), enumId).toBe(false);
      expect(customEasingCurveEnumLabel(enumId, "class:Snap"), enumId).toBe("Snap (Custom)");
    }
    for (const enumId of ["engine:Text2DAppearMode", "engine:TweenSpace", "my-enum", undefined]) {
      expect(isCustomEasingCurveEnumValue(enumId, "class:Snap"), String(enumId)).toBe(false);
      expect(customEasingCurveEnumLabel(enumId, "class:Snap"), String(enumId)).toBeNull();
    }
  });

  it("offers appearance choices that preserve serialized values and drive the selected transition", () => {
    const schemas = mergeEngineTypeSchemas();
    const choice = (id: string, name: string) => schemas.enums[id]?.members.find((member) => member.name === name)?.name;
    const properties = parseText2DAppearProperties({
      appearModes: [choice("engine:Text2DAppearMode", "fade"), choice("engine:Text2DAppearMode", "scale")],
      appearTransition: choice("engine:Text2DAppearTransition", "linear"),
      appearStart: choice("engine:Text2DAppearStart", "hidden"),
      appearInterval: 0, appearDuration: 1,
    });
    expect(properties).toMatchObject({ appearModes: ["fade", "scale"], appearStart: "hidden" });
    expect(text2DCharacterReveal(0.5, 1, 3, properties)).toBe(0.5);
  });
});

it("exposes native input asset references and readable runtime binding labels", () => {
  expect(
    ENGINE_STRUCTS.find((entry) => entry.id === "engine:InputType")?.fields,
  ).toEqual([
    { id: "engine:InputType.Name", name: "Name", typeId: "string" },
    { id: "engine:InputType.Asset", name: "Asset", typeId: "asset" },
  ]);
  expect(
    ENGINE_STRUCTS.find((entry) => entry.id === "engine:InputBinding")?.fields,
  ).toContainEqual({ name: "Label", typeId: "string", defaultValue: "" });
});
