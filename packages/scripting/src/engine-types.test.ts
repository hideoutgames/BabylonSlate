import { describe, expect, it } from "vitest";
import { parseText2DAppearProperties, text2DCharacterReveal } from "@babylonslate/core";
import { mergeEngineTypeSchemas } from "./type-defaults";
import {
  ENGINE_COLLISION_CHANNEL_ENUM_ID,
  ENGINE_ENUMS,
  ENGINE_HIT_RESULT_STRUCT_ID,
  ENGINE_STRUCTS,
} from "./engine-types";

describe("engine type registry", () => {
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

  it("registers Collision Channel and Hit Result", () => {
    expect(ENGINE_ENUMS.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      ENGINE_COLLISION_CHANNEL_ENUM_ID,
      "engine:Key",
      "engine:InputComponent",
    ]));
    expect(ENGINE_ENUMS.find((entry) => entry.id === ENGINE_COLLISION_CHANNEL_ENUM_ID)?.members.map((member) => member.name)).toEqual([
      "All",
      "WorldStatic",
      "WorldDynamic",
      "Pawn",
      "Visibility",
    ]);
    expect(ENGINE_STRUCTS.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      ENGINE_HIT_RESULT_STRUCT_ID,
      "engine:InputType",
      "engine:InputBinding",
    ]));
    expect(ENGINE_STRUCTS.find((entry) => entry.id === ENGINE_HIT_RESULT_STRUCT_ID)?.fields.map((field) => field.name)).toEqual([
      "Hit",
      "Location",
      "Normal",
      "Actor",
      "Distance",
    ]);
  });
});

it("exposes native input asset references and readable runtime binding labels", () => {
  expect(
    ENGINE_STRUCTS.find((entry) => entry.id === "engine:InputType")?.fields,
  ).toEqual([
    { name: "Name", typeId: "string" },
    { name: "Asset", typeId: "asset" },
  ]);
  expect(
    ENGINE_STRUCTS.find((entry) => entry.id === "engine:InputBinding")?.fields,
  ).toContainEqual({ name: "Label", typeId: "string", defaultValue: "" });
});
