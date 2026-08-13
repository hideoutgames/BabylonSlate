import { describe, expect, it } from "vitest";
import {
  STRUCTURE_FIELD_TYPES,
  addEnumMember,
  addScriptInterfaceMethod,
  addScriptInterfacePin,
  addStructureField,
  moveEnumMember,
  moveScriptInterfaceMethod,
  patchEnumMember,
  patchScriptInterfacePin,
  patchStructureField,
  patchTextureUsage,
  removeEnumMember,
  removeScriptInterfaceMethod,
  removeStructureField,
} from "./asset-settings";

describe("asset settings payloads", () => {
  it("appends, patches, reorders, and removes enum members", () => {
    let asset = addEnumMember({
      kind: "enum",
      guid: "e1",
      name: "Colors",
      members: [{ name: "None", value: 0 }],
    });
    expect(asset.members).toEqual([
      { name: "None", value: 0 },
      { name: "NewMember", value: 1 },
    ]);
    asset = patchEnumMember(asset, 1, { name: "Red" });
    asset = moveEnumMember(asset, 1, -1);
    expect(asset.members.map((member) => member.name)).toEqual(["Red", "None"]);
    asset = removeEnumMember(asset, 1);
    expect(asset.members).toEqual([{ name: "Red", value: 1 }]);
  });

  it("lists Structure field types used by the pin picker", () => {
    expect(STRUCTURE_FIELD_TYPES).toContain("float");
    expect(STRUCTURE_FIELD_TYPES).toContain("vec3");
    expect(STRUCTURE_FIELD_TYPES).toContain("struct");
  });

  it("appends, patches, and removes structure fields including defaults", () => {
    let asset = addStructureField({
      kind: "structure",
      guid: "s1",
      name: "Stats",
      fields: [],
    });
    expect(asset.fields).toEqual([{ name: "NewField", typeId: "float" }]);
    asset = patchStructureField(asset, 0, {
      name: "Health",
      typeId: "int",
      defaultValue: "100",
    });
    expect(asset.fields[0]).toEqual({
      name: "Health",
      typeId: "int",
      defaultValue: "100",
    });
    asset = removeStructureField(asset, 0);
    expect(asset.fields).toEqual([]);
  });

  it("appends ScriptInterface methods and pins with direction", () => {
    let asset = addScriptInterfaceMethod({
      kind: "scriptInterface",
      guid: "i1",
      name: "Interactable",
      methods: [],
    });
    expect(asset.methods).toHaveLength(1);
    expect(asset.methods[0]?.name).toBe("NewMethod");
    expect(asset.methods[0]?.pins).toEqual([]);
    asset = addScriptInterfacePin(asset, 0, "out");
    expect(asset.methods[0]?.pins).toEqual([
      { name: "NewOutput", typeId: "float", direction: "out" },
    ]);
    asset = patchScriptInterfacePin(asset, 0, 0, {
      name: "hit",
      typeId: "bool",
    });
    expect(asset.methods[0]?.pins[0]).toEqual({
      name: "hit",
      typeId: "bool",
      direction: "out",
    });
    asset = moveScriptInterfaceMethod(
      addScriptInterfaceMethod(asset),
      1,
      -1,
    );
    expect(asset.methods.map((method) => method.name)).toEqual([
      "NewMethod",
      "NewMethod",
    ]);
    asset = removeScriptInterfaceMethod(asset, 0);
    expect(asset.methods).toHaveLength(1);
  });

  it("patches texture usage without dropping compression state", () => {
    const next = patchTextureUsage(
      { compressionState: "compressed", usage: "albedo" },
      "pixelArt",
    );
    expect(next).toEqual({
      compressionState: "compressed",
      usage: "pixelArt",
    });
  });
});
