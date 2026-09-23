import { expect, it } from "vitest";
import { ENGINE_STRUCTS } from "./engine-types";

it("exposes CEL outline appearance with the graph's native Color value", () => {
  const fields = ENGINE_STRUCTS.find((entry) => entry.id === "engine:CelShading")!.fields;
  expect(fields.find((field) => field.name === "outlinesEnabled")).toMatchObject({ typeId: "bool", defaultValue: true });
  expect(fields.find((field) => field.name === "outlineWidth")).toMatchObject({ typeId: "float", defaultValue: 1 });
  const color = fields.find((field) => field.name === "outlineColor")!;
  expect(color.defaultValue).toEqual({ x: 0.03, y: 0.03, z: 0.03, w: 1 });
  expect(color.typeId).toBe("color");
  expect(color.typeClassId).toBeUndefined();
});
