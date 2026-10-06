import { describe, expect, it } from "vitest";
import {
  addEnumMember,
  addScriptInterfaceMethod,
  addStructureField,
  moveEnumMember,
  patchEnumMember,
  patchScriptInterfaceMethod,
  patchStructureField,
  patchTextureUsage,
  applyTextureDownsampleChange,
  applyTextureUsageChange,
  textureDownsampleSelectValue,
  patchTextureDownsample,
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

  it("appends, patches, and removes structure fields including defaults", () => {
    let asset = addStructureField({
      kind: "structure",
      guid: "s1",
      name: "Stats",
      fields: [],
    });
    expect(asset.fields).toEqual([{ id: expect.any(String), name: "NewField", typeId: "float" }]);
    const id = asset.fields[0]!.id;
    asset = patchStructureField(asset, 0, {
      name: "Health",
      typeId: "int",
      defaultValue: "100",
    });
    expect(asset.fields[0]).toEqual({
      id,
      name: "Health",
      typeId: "int",
      defaultValue: "100",
    });
    asset = removeStructureField(asset, 0);
    expect(asset.fields).toEqual([]);
  });

  it("retains legacy identity across repeated renames and creates distinct fields", () => {
    let asset = patchStructureField({
      kind: "structure", guid: "stats", name: "Stats",
      fields: [{ name: "Health", typeId: "int" }],
    }, 0, { name: "HitPoints" });
    asset = patchStructureField(asset, 0, { name: "HP" });
    expect(asset.fields[0]).toEqual({ id: "legacy:Health", name: "HP", typeId: "int" });
    asset = addStructureField(addStructureField(asset));
    expect(asset.fields.map((field) => field.name)).toEqual(["HP", "NewField", "NewField2"]);
    expect(new Set(asset.fields.map((field) => field.id)).size).toBe(3);
  });

  it("appends, patches pin rows on, and removes ScriptInterface methods", () => {
    let asset = addScriptInterfaceMethod({
      kind: "scriptInterface",
      guid: "i1",
      name: "Interactable",
      methods: [],
    });
    expect(asset.methods).toHaveLength(1);
    expect(asset.methods[0]?.name).toBe("NewMethod");
    expect(asset.methods[0]?.pins).toEqual([]);
    const hit = {
      name: "hit",
      typeId: "object",
      typeClassId: "Actor",
      direction: "out" as const,
    };
    asset = patchScriptInterfaceMethod(addScriptInterfaceMethod(asset), 1, {
      name: "Interact",
      pins: [hit],
    });
    expect(asset.methods).toEqual([
      { name: "NewMethod", pins: [] },
      { name: "Interact", pins: [hit] },
    ]);
    asset = removeScriptInterfaceMethod(asset, 0);
    expect(asset.methods).toEqual([{ name: "Interact", pins: [hit] }]);
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

  it("re-encodes when Usage enters or leaves Particle, which changes the encode size", () => {
    const requeues = (from: string, to: string) =>
      applyTextureUsageChange({ usage: from, compressionState: "compressed" }, to);
    expect(requeues("albedo", "particle")).toEqual({
      payload: { usage: "particle", compressionState: "compressed" },
      shouldRequeue: true,
    });
    expect(requeues("pixelArt", "particle").shouldRequeue).toBe(true);
    expect(requeues("particle", "normal").shouldRequeue).toBe(true);
    // Leaving to an uncompressed Usage has nothing to encode.
    expect(requeues("particle", "pixelArt").shouldRequeue).toBe(false);
    // Other Usage edits keep their current behaviour.
    expect(requeues("albedo", "normal").shouldRequeue).toBe(false);
    expect(requeues("particle", "particle").shouldRequeue).toBe(false);
  });

  it("patches per-asset texture downsample and requeues compressible usages", () => {
    expect(patchTextureDownsample({ usage: "albedo" }, 4)).toEqual({
      usage: "albedo",
      downsample: 4,
    });
    expect(textureDownsampleSelectValue({ usage: "albedo" })).toBe("1");
    expect(
      textureDownsampleSelectValue({ usage: "albedo", downsample: 4 }),
    ).toBe("4");
    expect(applyTextureDownsampleChange({ usage: "albedo" }, "4")).toEqual({
      payload: { usage: "albedo", downsample: 4 },
      shouldRequeue: true,
    });
    expect(applyTextureDownsampleChange({ usage: "pixelArt" }, "4")).toEqual({
      payload: { usage: "pixelArt", downsample: 4 },
      shouldRequeue: false,
    });
  });
});
