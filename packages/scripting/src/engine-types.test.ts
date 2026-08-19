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

  it("registers Input Mode, Collision Channel, and Hit Result", () => {
    expect(ENGINE_ENUMS.map((entry) => entry.id)).toEqual([
      "engine:InputMode",
      ENGINE_COLLISION_CHANNEL_ENUM_ID,
    ]);
    expect(ENGINE_ENUMS[0]?.members.map((member) => member.name)).toEqual([
      "All",
      "Interface",
      "Game",
    ]);
    expect(ENGINE_ENUMS[1]?.members.map((member) => member.name)).toEqual([
      "All",
      "WorldStatic",
      "WorldDynamic",
      "Pawn",
      "Visibility",
    ]);
    expect(ENGINE_STRUCTS.map((entry) => entry.id)).toEqual([
      ENGINE_HIT_RESULT_STRUCT_ID,
    ]);
    expect(ENGINE_STRUCTS[0]?.fields.map((field) => field.name)).toEqual([
      "Hit",
      "Location",
      "Normal",
      "Actor",
      "Distance",
    ]);
  });
});
