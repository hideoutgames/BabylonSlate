import { describe, expect, it } from "vitest";
import { clearDeletedAssetRefs } from "./clear-asset-refs";
import { findClassAssetReferences, replaceClassAssetReferences } from "./class-asset-refs";
import { dataAssetDependencies, dataGraphAssetDependencies } from "./data-asset-refs";
import { remapImportResultGuids } from "./importers/guid-remap";
import type { ImportResult } from "./importers/types";

function object() {
  return {
    kind: "dataObject", structureGuid: "weapon", values: {
      Name: "texture", assetGuid: "texture", ClassText: "Hero", ClassGuidText: "hero",
      Icon: "texture", Spawn: "Hero", Stats: { Portrait: "texture", Caption: "texture", Grade: "Common" },
      RemovedIcon: "old-texture", Untracked: "texture",
    },
    schema: [
      { name: "Name", typeId: "string" }, { name: "assetGuid", typeId: "string" },
      { name: "ClassText", typeId: "string" }, { name: "ClassGuidText", typeId: "string" },
      { name: "Icon", typeId: "asset", typeClassId: "Texture" },
      { name: "Spawn", typeId: "class", typeClassId: "Hero" },
      { name: "Stats", typeId: "struct", typeClassId: "stats", fields: [
        { name: "Portrait", typeId: "asset", typeClassId: "Texture" },
        { name: "Caption", typeId: "string" },
        { name: "Grade", typeId: "enum", typeClassId: "grade" },
      ] },
      { name: "RemovedIcon", typeId: "asset", typeClassId: "Texture" },
    ],
  };
}

function imported(type: string, guid: string, payload: Record<string, unknown>): ImportResult {
  return { type, guid, name: guid, version: 1, dependencies: [], payload: {}, chunks: [
    { id: "document", kind: "document", mime: "application/json", data: new TextEncoder().encode(JSON.stringify(payload)) },
  ] };
}

function body(asset: ImportResult): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(asset.chunks[0]!.data));
}

describe("Data asset reference lifecycle", () => {
  it("collects nested and retained typed dependencies without guessing references from text", () => {
    expect(dataAssetDependencies("DataObject", object(), [{ guid: "hero", classId: "Hero" }]))
      .toEqual(["grade", "hero", "old-texture", "stats", "texture", "weapon"]);
    expect(dataAssetDependencies("DataObject", { ...object(), schema: [] })).toEqual(["weapon"]);
    expect(dataAssetDependencies("DataSheet", { kind: "dataSheet", structureGuid: "weapon", objectGuids: ["sword", "shield"] }))
      .toEqual(["shield", "sword", "weapon"]);
  });

  it("imports a colliding object and sheet as references to the same remapped standalone asset", () => {
    const source = object();
    const results = [
      imported("DataObject", "sword", source),
      imported("DataSheet", "weapons", { kind: "dataSheet", structureGuid: "weapon", objectGuids: ["sword"] }),
      imported("Structure", "weapon", { kind: "structure", guid: "weapon", name: "weapon", fields: [
        { name: "Stats", typeId: "struct", typeClassId: "stats" },
        { name: "Title", typeId: "string", defaultValue: "stats" },
      ] }),
      imported("Structure", "stats", { kind: "structure", guid: "stats", fields: [{ name: "Grade", typeId: "enum", typeClassId: "grade" }] }),
      imported("Enum", "grade", { kind: "enum", guid: "grade", name: "grade", members: [{ name: "Common", value: 0 }] }),
      imported("Texture", "texture", {}),
    ];
    const mapped = remapImportResultGuids(results, new Set(["sword", "weapon", "stats", "grade", "texture"]));
    const [sword, sheet, weapon, stats, grade, texture] = mapped;
    expect(body(sheet!)).toMatchObject({ structureGuid: weapon!.guid, objectGuids: [sword!.guid] });
    expect(body(sword!)).toMatchObject({ structureGuid: weapon!.guid, values: {
      Icon: texture!.guid, Name: "texture", assetGuid: "texture", Untracked: "texture",
      Stats: { Portrait: texture!.guid, Caption: "texture", Grade: "Common" },
    } });
    expect(body(weapon!)).toMatchObject({ guid: weapon!.guid, name: "weapon", fields: [
      { typeClassId: stats!.guid }, { defaultValue: "stats" },
    ] });
    expect(body(stats!)).toMatchObject({ guid: stats!.guid, fields: [{ typeClassId: grade!.guid }] });
    expect(body(grade!)).toMatchObject({ guid: grade!.guid, name: "grade" });
    expect(body(results[0]!)).toEqual(source);
  });

  it("clears typed references while preserving free text and independent sheet members", () => {
    const source = object();
    const cleared = clearDeletedAssetRefs(source, new Set(["texture", "weapon", "stats", "grade"]));
    expect(cleared.changed).toBe(true);
    expect(cleared.value).toMatchObject({ structureGuid: null, values: {
      Name: "texture", assetGuid: "texture", Icon: "", Untracked: "texture",
      Stats: { Portrait: "", Caption: "texture", Grade: "Common" },
    } });
    expect(cleared.value.schema[6]).not.toHaveProperty("typeClassId");
    expect(source.values.Icon).toBe("texture");
    const sheet = { kind: "dataSheet", structureGuid: "weapon", objectGuids: ["sword", "shield"] };
    expect(clearDeletedAssetRefs(sheet, new Set(["sword"])).value.objectGuids).toEqual(["shield"]);
    expect(clearDeletedAssetRefs(source, new Set(["unrelated"]))).toEqual({ value: source, changed: false });
  });

  it("replaces Class constraints and values without changing class-like strings", () => {
    const source = object();
    const hero = { guid: "hero", classId: "Hero" };
    expect(findClassAssetReferences(source, [hero])).toEqual(["hero"]);
    const replaced = replaceClassAssetReferences(source, [{ ...hero, replacement: { guid: "npc", classId: "NPC" } }]);
    expect(replaced.value.values).toMatchObject({ Spawn: "NPC", ClassText: "Hero", ClassGuidText: "hero" });
    expect(replaced.value.schema[5]!.typeClassId).toBe("NPC");
    const cleared = clearDeletedAssetRefs(source, new Set(["hero"]), new Set(["Hero"]));
    expect(cleared.value.values).toMatchObject({ Spawn: "", ClassText: "Hero", ClassGuidText: "hero" });
  });

  it("tracks and remaps data node literals, variables, and utility sheet lists in nested graphs", () => {
    const graph = { nodes: [
      { type: "data.readObject", data: { properties: { structGuid: "weapon", "default:object": "sword", label: "sword" } } },
      { type: "data.getSheetObjects", data: { properties: { "default:sheet": "weapons" } } },
    ], members: [
      { kind: "variable", typeId: "asset", typeClassId: "DataObject", defaultValue: "shield" },
      { kind: "variable", typeId: "string", defaultValue: "ignored" },
    ], functions: [{ nodes: [{ type: "editorData.createSheet", data: { properties: { "default:objects": ["sword", "shield"] } } }] }] };
    expect(dataGraphAssetDependencies(graph)).toEqual(["shield", "sword", "weapon", "weapons"]);
    const mapped = remapImportResultGuids([imported("Class", "class", graph), imported("DataObject", "sword", object())], new Set(["sword"]));
    const result = body(mapped[0]!);
    expect(result.nodes).toMatchObject([{ data: { properties: { "default:object": mapped[1]!.guid, label: "sword" } } }, {}]);
    expect(result.functions).toMatchObject([{ nodes: [{ data: { properties: { "default:objects": [mapped[1]!.guid, "shield"] } } }] }]);
  });

  it("uses a data node's saved schema for nested literal imports and deletion", () => {
    const props = { structGuid: "weapon", dataSchema: [
      { name: "Icon", typeId: "asset", typeClassId: "Texture" },
      { name: "Metadata", typeId: "struct", typeClassId: "metadata", fields: [
        { name: "Name", typeId: "string" }, { name: "Asset", typeId: "string" },
      ] },
    ], "default:values": { Icon: "texture", Metadata: { Name: "Label", Asset: "texture" } } };
    const graph = { nodes: [{ type: "editorData.createObject", data: { properties: props } }] };
    expect(dataGraphAssetDependencies(graph)).toEqual(["metadata", "texture", "weapon"]);
    const mapped = remapImportResultGuids([imported("Class", "class", graph), imported("Texture", "texture", {})], new Set(["texture"]));
    expect(body(mapped[0]!).nodes).toMatchObject([{ data: { properties: {
      "default:values": { Icon: mapped[1]!.guid, Metadata: { Name: "Label", Asset: "texture" } },
    } } }]);
    expect(clearDeletedAssetRefs(graph, new Set(["texture"])).value.nodes[0]!.data.properties["default:values"])
      .toEqual({ Icon: "", Metadata: { Name: "Label", Asset: "texture" } });
    expect(replaceClassAssetReferences(graph, [{ guid: "texture", classId: "TextureClass", replacement: null }]).value.nodes[0]!.data.properties["default:values"])
      .toEqual({ Icon: "", Metadata: { Name: "Label", Asset: "texture" } });
  });
});
