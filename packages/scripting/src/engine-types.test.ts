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

  it("starts with no engine enum or struct assets (pin-kind math types stay first-class)", () => {
    expect(ENGINE_ENUMS).toEqual([]);
    expect(ENGINE_STRUCTS).toEqual([]);
  });
});
