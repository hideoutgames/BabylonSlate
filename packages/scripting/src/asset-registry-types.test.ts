import { describe, expect, it } from "vitest";
import { ASSET_TYPES } from "@babylonslate/core";
import { pinTypeForVariable } from "./member-pin-type";
import { mergeEngineTypeSchemas, structInstanceDefault } from "./type-defaults";
import { arrayOf, assetRef, classRef, enumRef } from "./types";

describe("Asset Registry engine types", () => {
  const schemas = mergeEngineTypeSchemas();
  const fields = (id: string) => schemas.structs[id]!.fields;

  it("offers every asset header type as an Asset Type member, once", () => {
    const names = schemas.enums["engine:AssetType"]!.members.map((member) => member.name);
    expect(names).toEqual([...ASSET_TYPES]);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(["Scene", "Class", "Texture", "Material", "Model", "DataTree"]));
  });

  it("shapes Asset Data as the seven fields the runtime fills", () => {
    expect(fields("engine:AssetData").map((field) => [field.name, pinTypeForVariable(field)])).toEqual([
      ["Asset", assetRef("")],
      ["Name", { kind: "string" }],
      ["Path", { kind: "string" }],
      ["Folder", { kind: "string" }],
      ["Type", enumRef("engine:AssetType")],
      ["Class", classRef("BObject")],
      ["ParentClass", classRef("BObject")],
    ]);
  });

  it("starts an Asset Filter recursive, with subclasses, and with no other constraint", () => {
    expect(structInstanceDefault(fields("engine:AssetFilter"), schemas)).toEqual({
      Folders: [],
      Recursive: true,
      Types: [],
      Classes: [],
      IncludeSubclasses: true,
      NameContains: "",
    });
    expect(fields("engine:AssetFilter").map((field) => pinTypeForVariable(field))).toEqual([
      arrayOf({ kind: "string" }),
      { kind: "bool" },
      arrayOf(enumRef("engine:AssetType")),
      arrayOf(classRef("BObject")),
      { kind: "bool" },
      { kind: "string" },
    ]);
  });
});
