import { describe, expect, it } from "vitest";
import {
  assetRowIdentity,
  classRowIdentity,
} from "./picker-identity";

describe("assetRowIdentity", () => {
  it("maps an asset to picker button fields", () => {
    expect(assetRowIdentity({ name: "Boss.Phase", type: "Scene" })).toEqual({
      displayLabel: "Boss.Phase",
      displayType: "Scene",
      visual: { assetType: "Scene" },
    });
    expect(assetRowIdentity(undefined)).toEqual({});
  });
});

describe("classRowIdentity", () => {
  it("maps a class entry to picker button fields", () => {
    expect(classRowIdentity({ id: "Hero", name: "Hero" })).toEqual({
      displayLabel: "Hero",
      displayType: "Class",
      visual: { classId: "Hero", family: "class" },
    });
    expect(classRowIdentity(undefined, "BObject")).toEqual({
      displayLabel: "BObject",
      displayType: "Class",
      visual: { classId: "BObject", family: "class" },
    });
    expect(classRowIdentity(undefined)).toEqual({});
  });
});
