import { describe, expect, it } from "vitest";
import {
  ENGINE_ENUMS,
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

  it("registers Input Mode and leaves engine structs empty (pin-kind math stays first-class)", () => {
    expect(ENGINE_ENUMS.map((entry) => entry.id)).toEqual(["engine:InputMode"]);
    expect(ENGINE_ENUMS[0]?.members.map((member) => member.name)).toEqual([
      "All",
      "Interface",
      "Game",
    ]);
    expect(ENGINE_STRUCTS).toEqual([]);
  });
});
