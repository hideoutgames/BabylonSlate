import { describe, expect, it } from "vitest";
import { clearDeletedAssetRefs } from "./clear-asset-refs";
import { findClassAssetReferences, replaceClassAssetReferences } from "./class-asset-refs";
import { dataAssetDependencies, dataGraphAssetDependencies } from "./data-asset-refs";
import { remapImportResultGuids } from "./importers/guid-remap";
import type { ImportResult } from "./importers/types";

function sheet() {
  return { kind: "dataSheet", definitionGuid: "weapon", rows: [{
    id: "texture", name: "hero", values: {
      Label: "texture", assetGuid: "texture", ClassText: "Hero", ClassGuidText: "hero",
      Icon: "texture", Spawn: "Hero", Stats: { Portrait: "texture", Caption: "texture", Grade: "Common" },
    }, schema: [
      { name: "Label", typeId: "string" }, { name: "assetGuid", typeId: "string" },
      { name: "ClassText", typeId: "string" }, { name: "ClassGuidText", typeId: "string" },
      { name: "Icon", typeId: "asset", typeClassId: "Texture" },
      { name: "Spawn", typeId: "class", typeClassId: "Hero" },
      { name: "Stats", typeId: "struct", typeClassId: "stats", fields: [
        { name: "Portrait", typeId: "asset", typeClassId: "Texture" },
        { name: "Caption", typeId: "string" }, { name: "Grade", typeId: "enum", typeClassId: "grade" },
      ] },
    ],
  }] };
}
function imported(type: string, guid: string, payload: Record<string, unknown>): ImportResult {
  return { type, guid, name: guid, version: type === "DataSheet" ? 2 : 1, dependencies: [], payload: {}, chunks: [
    { id: "document", kind: "document", mime: "application/json", data: new TextEncoder().encode(JSON.stringify(payload)) },
  ] };
}
function body(asset: ImportResult): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(asset.chunks[0]!.data));
}

describe("Data Definition and owned row reference lifecycle", () => {
  it("collects typed values and definition defaults without inferring references from row identity or text", () => {
    expect(dataAssetDependencies("DataSheet", sheet(), [{ guid: "hero", classId: "Hero" }]))
      .toEqual(["grade", "hero", "stats", "texture", "weapon"]);
    expect(dataAssetDependencies("DataSheet", { ...sheet(), rows: [{ id: "texture", name: "hero", values: { Icon: "texture" } }] }))
      .toEqual(["weapon"]);
    const definition = { kind: "dataDefinition", fields: [
      { id: "icon", name: "Icon", typeId: "asset", typeClassId: "Texture", defaultValue: "texture", description: "unrelated" },
      { id: "label", name: "Label", typeId: "string", defaultValue: "unrelated", category: "unrelated" },
      { id: "grade", name: "Grade", typeId: "enum", typeClassId: "grade" },
    ] };
    expect(dataAssetDependencies("DataDefinition", definition)).toEqual(["grade", "texture"]);
  });

  it("remaps bundled schemas and typed values without changing the sheet's row IDs or names", () => {
    const source = sheet();
    const results = [
      imported("DataSheet", "weapons", source),
      imported("DataDefinition", "weapon", { kind: "dataDefinition", fields: [
        { id: "stats", name: "Stats", typeId: "struct", typeClassId: "stats" },
        { id: "title", name: "Title", typeId: "string", defaultValue: "stats" },
      ] }),
      imported("Structure", "stats", { kind: "structure", guid: "stats", fields: [{ name: "Grade", typeId: "enum", typeClassId: "grade" }] }),
      imported("Enum", "grade", { kind: "enum", guid: "grade", name: "grade", members: [{ name: "Common", value: 0 }] }),
      imported("Texture", "texture", {}),
    ];
    const [weapons, definition, stats, grade, texture] = remapImportResultGuids(results, new Set(["weapons", "weapon", "stats", "grade", "texture"]));
    expect(body(weapons!)).toMatchObject({ definitionGuid: definition!.guid, rows: [{ id: "texture", name: "hero", values: {
      Icon: texture!.guid, Label: "texture", assetGuid: "texture", Stats: { Portrait: texture!.guid, Caption: "texture", Grade: "Common" },
    } }] });
    expect(body(definition!)).toMatchObject({ fields: [{ id: "stats", typeClassId: stats!.guid }, { defaultValue: "stats" }] });
    expect(body(stats!)).toMatchObject({ guid: stats!.guid, fields: [{ typeClassId: grade!.guid }] });
    expect(body(grade!)).toMatchObject({ guid: grade!.guid, name: "grade" });
    expect(body(results[0]!)).toEqual(source);
  });

  it("uses a definition for external rows without snapshots during import, reference discovery, and deletion", () => {
    const fields = [{ id: "icon", name: "Icon", typeId: "asset", typeClassId: "Texture" }, { id: "label", name: "Label", typeId: "string" }];
    const payload = { kind: "dataSheet", definitionGuid: "weapon", rows: [{ id: "texture", name: "texture", values: { Icon: "texture", Label: "texture" } }] };
    const resolve = (guid: string) => guid === "weapon" ? fields : undefined;
    expect(dataAssetDependencies("DataSheet", payload, [], resolve)).toEqual(["texture", "weapon"]);
    const results = remapImportResultGuids([
      imported("DataSheet", "sheet", payload), imported("DataDefinition", "weapon", { kind: "dataDefinition", fields }), imported("Texture", "texture", {}),
    ], new Set(["texture"]));
    expect(body(results[0]!)).toMatchObject({ rows: [{ id: "texture", name: "texture", values: { Icon: results[2]!.guid, Label: "texture" } }] });
    expect(clearDeletedAssetRefs(payload, new Set(["texture"]), new Set(), resolve).value.rows)
      .toEqual([{ id: "texture", name: "texture", values: { Icon: "", Label: "texture" } }]);
  });

  it("resolves nested definitions for defaults, owned rows, and map keys without embedded snapshots", () => {
    const child = { kind: "dataDefinition", fields: [
      { id: "icon", name: "Icon", typeId: "asset", typeClassId: "Texture", defaultValue: "" },
      { id: "caption", name: "Caption", typeId: "string", defaultValue: "" },
    ] };
    const value = { Icon: "texture", Caption: "texture" };
    const parent = { kind: "dataDefinition", fields: [
      { id: "child", name: "Child", typeId: "struct", typeClassId: "child", defaultValue: value },
      { id: "keys", name: "Keys", typeId: "string", container: "map", keyTypeId: "struct", keyTypeClassId: "child", defaultValue: [{ key: value, value: "texture" }] },
    ] };
    const payload = { kind: "dataSheet", definitionGuid: "parent", rows: [{ id: "texture", name: "texture", values: { Child: value, Keys: [{ key: value, value: "texture" }] } }] };
    const resolve = (guid: string) => guid === "parent" ? parent.fields : guid === "child" ? child.fields : undefined;
    expect(dataAssetDependencies("DataDefinition", parent, [], resolve)).toEqual(["child", "texture"]);
    expect(dataAssetDependencies("DataSheet", payload, [], resolve)).toEqual(["parent", "texture"]);
    const results = remapImportResultGuids([
      imported("DataDefinition", "parent", parent), imported("DataDefinition", "child", child),
      imported("DataSheet", "sheet", payload), imported("Texture", "texture", {}),
    ], new Set(["child", "texture"]));
    const mapped = { Icon: results[3]!.guid, Caption: "texture" };
    expect(body(results[0]!)).toMatchObject({ fields: [
      { typeClassId: results[1]!.guid, defaultValue: mapped },
      { keyTypeClassId: results[1]!.guid, defaultValue: [{ key: mapped, value: "texture" }] },
    ] });
    expect(body(results[2]!)).toMatchObject({ rows: [{ id: "texture", name: "texture", values: { Child: mapped, Keys: [{ key: mapped, value: "texture" }] } }] });
    const cleared = { Icon: "", Caption: "texture" };
    expect(clearDeletedAssetRefs(parent, new Set(["texture"]), new Set(), resolve).value.fields)
      .toMatchObject([{ defaultValue: cleared }, { defaultValue: [{ key: cleared, value: "texture" }] }]);
    expect(clearDeletedAssetRefs(payload, new Set(["texture"]), new Set(), resolve).value.rows)
      .toMatchObject([{ id: "texture", name: "texture", values: { Child: cleared, Keys: [{ key: cleared, value: "texture" }] } }]);
  });

  it("clears typed references and Class values while preserving every owned row and ordinary string", () => {
    const source = sheet();
    const cleared = clearDeletedAssetRefs(source, new Set(["texture", "weapon", "stats", "grade"]));
    expect(cleared.value).toMatchObject({ definitionGuid: null, rows: [{ id: "texture", name: "hero", values: {
      Label: "texture", assetGuid: "texture", Icon: "", Stats: { Portrait: "", Caption: "texture", Grade: "Common" },
    } }] });
    expect(cleared.value.rows[0]!.schema[6]).not.toHaveProperty("typeClassId");
    const hero = { guid: "hero", classId: "Hero" };
    expect(findClassAssetReferences(source, [hero])).toEqual(["hero"]);
    const replaced = replaceClassAssetReferences(source, [{ ...hero, replacement: { guid: "npc", classId: "NPC" } }]);
    expect(replaced.value.rows[0]).toMatchObject({ id: "texture", name: "hero", values: { Spawn: "NPC", ClassText: "Hero", ClassGuidText: "hero" } });
    expect(replaced.value.rows[0]!.schema[5]!.typeClassId).toBe("NPC");
    expect(clearDeletedAssetRefs(source, new Set(["hero"]), new Set(["Hero"])).value.rows[0]!.values)
      .toMatchObject({ Spawn: "", ClassText: "Hero", ClassGuidText: "hero" });
    expect(source.rows[0]!.values.Icon).toBe("texture");
    expect(clearDeletedAssetRefs(source, new Set(["unrelated"])).value).toBe(source);
  });

  it("traverses typed containers and nested map keys while preserving text, tags, and array positions", () => {
    const row = { id: "row", name: "Entry", values: {
      Icons: ["texture", "keep", "texture"],
      ByAsset: [{ key: "texture", value: "Delete Pair" }, { key: "keep", value: "texture" }],
      ByStats: [{ key: { Icon: "texture", Caption: "texture" }, value: "texture" }],
      Actors: ["Hero", "Keep"], Tags: ["texture", "hero"],
      ByClass: [{ key: "Hero", value: "Hero" }, { key: "Keep", value: "Hero" }],
    }, schema: [
      { name: "Icons", typeId: "asset", container: "array" },
      { name: "ByAsset", typeId: "string", container: "map", keyTypeId: "asset" },
      { name: "ByStats", typeId: "string", container: "map", keyTypeId: "struct", keyTypeClassId: "stats", keyFields: [
        { name: "Icon", typeId: "asset", typeClassId: "Texture" }, { name: "Caption", typeId: "string" },
      ] },
      { name: "Actors", typeId: "class", container: "array" }, { name: "Tags", typeId: "tag", container: "array" },
      { name: "ByClass", typeId: "class", container: "map", keyTypeId: "class", keyTypeClassId: "Hero" },
    ] };
    const payload = { kind: "dataSheet", definitionGuid: "inventory", rows: [row] };
    expect(dataAssetDependencies("DataSheet", payload, [{ guid: "hero", classId: "Hero" }])).toEqual(["hero", "inventory", "keep", "stats", "texture"]);
    const mapped = remapImportResultGuids([imported("DataSheet", "inventory-sheet", payload), imported("Texture", "texture", {}), imported("Structure", "stats", {})], new Set(["texture", "stats"]));
    expect(body(mapped[0]!).rows).toMatchObject([{ values: { Icons: [mapped[1]!.guid, "keep", mapped[1]!.guid], ByStats: [{ key: { Icon: mapped[1]!.guid, Caption: "texture" }, value: "texture" }], Tags: ["texture", "hero"] }, schema: [{}, {}, { keyTypeClassId: mapped[2]!.guid }, {}, {}, {}] }]);
    expect(clearDeletedAssetRefs(payload, new Set(["texture"]), new Set(["Hero"])).value.rows[0]!.values).toEqual({
      Icons: ["", "keep", ""], ByAsset: [{ key: "keep", value: "texture" }],
      ByStats: [{ key: { Icon: "", Caption: "texture" }, value: "texture" }],
      Actors: ["", "Keep"], Tags: ["texture", "hero"], ByClass: [{ key: "Keep", value: "" }],
    });
  });

  it("tracks graph assets and typed literals without treating local row identifiers as assets", () => {
    const props = { definitionGuid: "weapon", "default:sheet": "sheet", "default:rowId": "texture", "default:name": "texture", dataSchema: [
      { name: "Icon", typeId: "asset", typeClassId: "Texture" },
      { name: "Metadata", typeId: "struct", typeClassId: "metadata", fields: [{ name: "Name", typeId: "string" }, { name: "Asset", typeId: "string" }] },
    ], "default:values": { Icon: "texture", Metadata: { Name: "Label", Asset: "texture" } } };
    const graph = { nodes: [
      { type: "editorData.updateRow", data: { properties: props } },
      { type: "data.readRow", data: { properties: { definitionGuid: "weapon", "default:sheet": "sheet", "default:rowId": "unused" } } },
      { type: "editorData.reorderRows", data: { properties: { "default:sheet": "sheet", "default:rowIds": ["texture", "unused"] } } },
    ] };
    expect(dataGraphAssetDependencies(graph)).toEqual(["metadata", "sheet", "texture", "weapon"]);
    const mapped = remapImportResultGuids([imported("Class", "class", graph), imported("Texture", "texture", {})], new Set(["texture"]));
    expect(body(mapped[0]!).nodes).toMatchObject([{ data: { properties: { "default:rowId": "texture", "default:name": "texture", "default:values": { Icon: mapped[1]!.guid, Metadata: { Name: "Label", Asset: "texture" } } } } }, {}, { data: { properties: { "default:rowIds": ["texture", "unused"] } } }]);
    const cleared = clearDeletedAssetRefs(graph, new Set(["texture"])).value;
    expect(cleared.nodes[0]!.data.properties).toMatchObject({ "default:rowId": "texture", "default:name": "texture", "default:values": { Icon: "", Metadata: { Name: "Label", Asset: "texture" } } });
    expect(cleared.nodes[2]!.data.properties).toMatchObject({ "default:rowIds": ["texture", "unused"] });
    expect(replaceClassAssetReferences(graph, [{ guid: "texture", classId: "Legacy", replacement: null }]).value.nodes[0]!.data.properties)
      .toMatchObject({ "default:rowId": "texture", "default:name": "texture", "default:values": { Icon: "" } });
  });

  it("preserves unsupported historical bodies instead of reinterpreting them as definitions or owned rows", () => {
    const legacyObject = { kind: "dataObject", structureGuid: "old", values: { Label: "texture" } };
    const legacySheet = { kind: "dataSheet", structureGuid: "old", objectGuids: ["texture"] };
    expect(clearDeletedAssetRefs(legacyObject, new Set(["texture", "old"])).value).toBe(legacyObject);
    expect(clearDeletedAssetRefs(legacySheet, new Set(["texture", "old"])).value).toBe(legacySheet);
    const imports = [imported("DataObject", "texture", legacyObject), imported("DataSheet", "old-sheet", legacySheet)];
    expect(remapImportResultGuids(imports, new Set())).toBe(imports);
    expect(() => remapImportResultGuids(imports, new Set(["texture"]))).toThrow(/Legacy/);
    expect(body(imports[0]!)).toEqual(legacyObject);
  });
});
