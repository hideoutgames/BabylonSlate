import { describe, expect, it } from "vitest";
import {
  ENGINE_COLLISION_CHANNEL_ENUM_ID,
  ENGINE_ENUMS,
  ENGINE_HIT_RESULT_STRUCT_ID,
  ENGINE_STRUCTS,
  ENGINE_TYPE_GUID_PREFIX,
  engineTypeGuid,
  isEngineTypeGuid,
} from "./engine-types";

describe("engine type registry", () => {
  it("prefixes stable engine ids without double-prefixing", () => {
    expect(engineTypeGuid("CollisionChannel")).toBe(
      `${ENGINE_TYPE_GUID_PREFIX}CollisionChannel`,
    );
    expect(engineTypeGuid("engine:CollisionChannel")).toBe(
      "engine:CollisionChannel",
    );
    expect(isEngineTypeGuid("engine:CollisionChannel")).toBe(true);
    expect(isEngineTypeGuid("asset-guid")).toBe(false);
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
