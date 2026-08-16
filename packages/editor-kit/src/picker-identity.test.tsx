import { describe, expect, it } from "vitest";
import {
  assetRowIdentity,
  classRowIdentity,
  displayPickerTitle,
} from "./picker-identity";

describe("displayPickerTitle", () => {
  it("strips a trailing type suffix so name and type are not duplicated", () => {
    expect(displayPickerTitle("main.scene")).toBe("main");
    expect(displayPickerTitle("logic.graph")).toBe("logic");
    expect(displayPickerTitle("main.class")).toBe("main");
    expect(displayPickerTitle("Hero")).toBe("Hero");
    expect(displayPickerTitle("crate.model")).toBe("crate");
  });
});

describe("assetRowIdentity", () => {
  it("maps an asset to picker button fields", () => {
    expect(assetRowIdentity({ name: "main.scene", type: "Scene" })).toEqual({
      displayLabel: "main",
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
