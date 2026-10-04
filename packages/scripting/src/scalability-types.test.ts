import { expect, it } from "vitest";
import { RENDER_QUALITY_PROFILES, WATER_REFLECTION_MODES, WATER_SHADING_DETAILS } from "@babylonslate/core";
import { ENGINE_ENUMS, ENGINE_STRUCTS } from "./engine-types";

it("exposes CEL outline appearance with the graph's native Color value", () => {
  const fields = ENGINE_STRUCTS.find((entry) => entry.id === "engine:CelShading")!.fields;
  expect(fields.find((field) => field.name === "outlinesEnabled")).toMatchObject({ typeId: "bool", defaultValue: true });
  expect(fields.find((field) => field.name === "outlineWidth")).toMatchObject({ typeId: "float", defaultValue: 1 });
  const color = fields.find((field) => field.name === "outlineColor")!;
  expect(color.defaultValue).toEqual({ x: 0.03, y: 0.03, z: 0.03, w: 1 });
  expect(color.typeId).toBe("color");
  expect(color.typeClassId).toBeUndefined();
});

it("sends the Medium water tier from default Set Water Quality inputs, using the session's enum names", () => {
  const fields = ENGINE_STRUCTS.find((entry) => entry.id === "engine:WaterQuality")!.fields;
  const { profile: _profile, preset: _preset, ...medium } = RENDER_QUALITY_PROFILES.medium.water;
  void _profile;
  void _preset;
  expect(Object.fromEntries(fields.map((field) => [field.name, field.defaultValue]))).toEqual(medium);
  const members = (id: string) => ENGINE_ENUMS.find((entry) => entry.id === id)!.members.map((member) => member.name);
  expect(members("engine:WaterShadingDetail")).toEqual(WATER_SHADING_DETAILS);
  expect(members("engine:WaterReflectionMode")).toEqual(WATER_REFLECTION_MODES);
});
