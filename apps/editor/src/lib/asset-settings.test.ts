import { describe, expect, it } from "vitest";
import {
  STRUCTURE_FIELD_TYPES,
  addEnumMember,
  addScriptInterfaceMethod,
  addStructureField,
  patchTextureUsage,
} from "./asset-settings";

describe("asset settings payloads", () => {
  it("appends enum members", () => {
    const next = addEnumMember({
      kind: "enum",
      guid: "e1",
      name: "Colors",
      members: [{ name: "None", value: 0 }],
    });
    expect(next.members).toEqual([
      { name: "None", value: 0 },
      { name: "NewMember", value: 1 },
    ]);
  });

  it("lists the Structure field type enum", () => {
    expect(STRUCTURE_FIELD_TYPES).toEqual([
      "float",
      "int",
      "bool",
      "string",
      "enum",
    ]);
  });

  it("appends structure fields", () => {
    const next = addStructureField({
      kind: "structure",
      guid: "s1",
      name: "Stats",
      fields: [],
    });
    expect(next.fields).toEqual([{ name: "NewField", typeId: "float" }]);
  });

  it("appends ScriptInterface methods", () => {
    const next = addScriptInterfaceMethod({
      kind: "scriptInterface",
      guid: "i1",
      name: "Interactable",
      methods: [],
    });
    expect(next.methods).toHaveLength(1);
    expect(next.methods[0]?.name).toBe("NewMethod");
    expect(next.methods[0]?.pins).toEqual([]);
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
