import { describe, expect, it } from "vitest";
import { clearDeletedAssetRefs } from "./clear-asset-refs";
import { findClassAssetReferences, replaceClassAssetReferences } from "./class-asset-refs";
import { dataAssetDependencies, dataGraphAssetDependencies } from "./data-asset-refs";
import { remapImportResultGuids } from "./importers/guid-remap";
import type { ImportResult } from "./importers/types";

function tree() {
  return { kind: "dataTree", defaultDefinitionGuid: "weapon", entries: [{
    id: "texture", parentId: null, name: "hero", values: {
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
  return { type, guid, name: guid, version: 1, dependencies: [], payload: {}, chunks: [
    { id: "document", kind: "document", mime: "application/json", data: new TextEncoder().encode(JSON.stringify(payload)) },
  ] };
}
function body(asset: ImportResult): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(asset.chunks[0]!.data));
}

describe("Data Definition and owned entry reference lifecycle", () => {
  it("collects typed values and definition defaults without inferring references from entry identity or text", () => {
    expect(dataAssetDependencies("DataTree", tree(), [{ guid: "hero", classId: "Hero" }]))
      .toEqual(["grade", "hero", "stats", "texture", "weapon"]);
    expect(dataAssetDependencies("DataTree", { ...tree(), entries: [{ id: "texture", parentId: null, name: "hero", values: { Icon: "texture" } }] }))
      .toEqual(["weapon"]);
    const definition = { kind: "dataDefinition", fields: [
      { id: "icon", name: "Icon", typeId: "asset", typeClassId: "Texture", defaultValue: "texture", description: "unrelated" },
      { id: "label", name: "Label", typeId: "string", defaultValue: "unrelated", category: "unrelated" },
      { id: "grade", name: "Grade", typeId: "enum", typeClassId: "grade" },
    ] };
    expect(dataAssetDependencies("DataDefinition", definition)).toEqual(["grade", "texture"]);
  });

  it("remaps bundled schemas and typed values without changing the tree's entry IDs or names", () => {
    const source = tree();
    const results = [
      imported("DataTree", "weapons", source),
      imported("DataDefinition", "weapon", { kind: "dataDefinition", fields: [
        { id: "stats", name: "Stats", typeId: "struct", typeClassId: "stats" },
        { id: "title", name: "Title", typeId: "string", defaultValue: "stats" },
      ] }),
      imported("Structure", "stats", { kind: "structure", guid: "stats", fields: [{ name: "Grade", typeId: "enum", typeClassId: "grade" }] }),
      imported("Enum", "grade", { kind: "enum", guid: "grade", name: "grade", members: [{ name: "Common", value: 0 }] }),
      imported("Texture", "texture", {}),
    ];
    const [weapons, definition, stats, grade, texture] = remapImportResultGuids(results, new Set(["weapons", "weapon", "stats", "grade", "texture"]));
    expect(body(weapons!)).toMatchObject({ defaultDefinitionGuid: definition!.guid, entries: [{ id: "texture", parentId: null, name: "hero", values: {
      Icon: texture!.guid, Label: "texture", assetGuid: "texture", Stats: { Portrait: texture!.guid, Caption: "texture", Grade: "Common" },
    } }] });
    expect(body(definition!)).toMatchObject({ fields: [{ id: "stats", typeClassId: stats!.guid }, { defaultValue: "stats" }] });
    expect(body(stats!)).toMatchObject({ guid: stats!.guid, fields: [{ typeClassId: grade!.guid }] });
    expect(body(grade!)).toMatchObject({ guid: grade!.guid, name: "grade" });
    expect(body(results[0]!)).toEqual(source);
  });

  it("uses a definition for external entries without snapshots during import, reference discovery, and deletion", () => {
    const fields = [{ id: "icon", name: "Icon", typeId: "asset", typeClassId: "Texture" }, { id: "label", name: "Label", typeId: "string" }];
    const payload = { kind: "dataTree", defaultDefinitionGuid: "weapon", entries: [{ id: "texture", parentId: null, name: "texture", values: { Icon: "texture", Label: "texture" } }] };
    const resolve = (guid: string) => guid === "weapon" ? fields : undefined;
    expect(dataAssetDependencies("DataTree", payload, [], resolve)).toEqual(["texture", "weapon"]);
    const results = remapImportResultGuids([
      imported("DataTree", "tree", payload), imported("DataDefinition", "weapon", { kind: "dataDefinition", fields }), imported("Texture", "texture", {}),
    ], new Set(["texture"]));
    expect(body(results[0]!)).toMatchObject({ entries: [{ id: "texture", parentId: null, name: "texture", values: { Icon: results[2]!.guid, Label: "texture" } }] });
    expect(clearDeletedAssetRefs(payload, new Set(["texture"]), new Set(), resolve).value.entries)
      .toEqual([{ id: "texture", parentId: null, name: "texture", values: { Icon: "", Label: "texture" } }]);
  });

  it("follows inherited Definition overrides without remapping parent identities or treating untyped values as references", () => {
    const fields = [{ id: "icon", name: "Icon", typeId: "asset", typeClassId: "Texture" }, { id: "label", name: "Label", typeId: "string" }];
    const resolve = (guid: string) => ["default-def", "override-def"].includes(guid) ? fields : undefined;
    const source = { kind: "dataTree", defaultDefinitionGuid: "default-def", entries: [
      { id: "default-def", parentId: "default-texture", name: "Inherited", values: { Icon: "default-texture", Label: "override-texture" } },
      { id: "default-texture", parentId: null, name: "default-def", values: {} },
      { id: "override-root", parentId: "default-texture", name: "Override", definitionGuid: "override-def", values: {} },
      { id: "override-child", parentId: "override-root", name: "Child", values: { Icon: "override-texture" } },
      { id: "group", parentId: "default-texture", name: "Group", definitionGuid: null, values: { Icon: "untyped-texture" } },
      { id: "untyped-child", parentId: "group", name: "Untyped", values: { Icon: "untyped-child-texture" } },
      { id: "retired", parentId: "group", name: "Retired", values: { Icon: "retired-texture" }, schema: fields },
    ] };
    expect(dataAssetDependencies("DataTree", source, [], resolve))
      .toEqual(["default-def", "default-texture", "override-def", "override-texture", "retired-texture"]);
    const results = remapImportResultGuids([
      imported("DataTree", "tree", source), imported("DataDefinition", "default-def", { kind: "dataDefinition", fields }),
      imported("DataDefinition", "override-def", { kind: "dataDefinition", fields }), imported("Texture", "default-texture", {}),
      imported("Texture", "override-texture", {}),
    ], new Set(["default-def", "override-def", "default-texture", "override-texture"]));
    expect(body(results[0]!)).toMatchObject({ defaultDefinitionGuid: results[1]!.guid, entries: [
      { id: "default-def", parentId: "default-texture", name: "Inherited", values: { Icon: results[3]!.guid, Label: "override-texture" } },
      { id: "default-texture", parentId: null, name: "default-def" },
      { definitionGuid: results[2]!.guid }, { values: { Icon: results[4]!.guid } },
      { definitionGuid: null, values: { Icon: "untyped-texture" } }, { values: { Icon: "untyped-child-texture" } },
      { values: { Icon: "retired-texture" } },
    ] });
    const cleared = clearDeletedAssetRefs(source, new Set(["default-def", "override-def", "default-texture", "override-texture", "retired-texture", "untyped-texture", "untyped-child-texture"]), new Set(), resolve).value;
    expect(cleared).toMatchObject({ defaultDefinitionGuid: null, entries: [
      { id: "default-def", parentId: "default-texture", values: { Icon: "", Label: "override-texture" } },
      { id: "default-texture", parentId: null }, { definitionGuid: null }, { values: { Icon: "" } },
      { definitionGuid: null, values: { Icon: "untyped-texture" } }, { values: { Icon: "untyped-child-texture" } },
      { values: { Icon: "" } },
    ] });
  });

  it("retains explicit schema references on damaged hierarchies without guessing inherited schemas", () => {
    const fields = [{ name: "Icon", typeId: "asset", typeClassId: "Texture" }];
    const source = { kind: "dataTree", defaultDefinitionGuid: "weapon", entries: [
      { id: "explicit", parentId: "missing", name: "Explicit", definitionGuid: "weapon", values: { Icon: "explicit-texture" } },
      { id: "saved", parentId: "missing", name: "Saved", values: { Icon: "saved-texture" }, schema: fields },
      { id: "inherited", parentId: "missing", name: "Inherited", values: { Icon: "unknown-texture" } },
    ] };
    const resolve = (guid: string) => guid === "weapon" ? fields : undefined;
    expect(dataAssetDependencies("DataTree", source, [], resolve)).toEqual(["explicit-texture", "saved-texture", "weapon"]);
    expect(clearDeletedAssetRefs(source, new Set(["explicit-texture", "saved-texture", "unknown-texture", "missing"]), new Set(), resolve).value.entries)
      .toMatchObject([{ parentId: "missing", values: { Icon: "" } }, { parentId: "missing", values: { Icon: "" } }, { parentId: "missing", values: { Icon: "unknown-texture" } }]);
  });

  it("resolves nested definitions for defaults, owned entries, and map keys without embedded snapshots", () => {
    const child = { kind: "dataDefinition", fields: [
      { id: "icon", name: "Icon", typeId: "asset", typeClassId: "Texture", defaultValue: "" },
      { id: "caption", name: "Caption", typeId: "string", defaultValue: "" },
    ] };
    const value = { Icon: "texture", Caption: "texture" };
    const parent = { kind: "dataDefinition", fields: [
      { id: "child", name: "Child", typeId: "struct", typeClassId: "child", defaultValue: value },
      { id: "keys", name: "Keys", typeId: "string", container: "map", keyTypeId: "struct", keyTypeClassId: "child", defaultValue: [{ key: value, value: "texture" }] },
    ] };
    const payload = { kind: "dataTree", defaultDefinitionGuid: "parent", entries: [{ id: "texture", parentId: null, name: "texture", values: { Child: value, Keys: [{ key: value, value: "texture" }] } }] };
    const resolve = (guid: string) => guid === "parent" ? parent.fields : guid === "child" ? child.fields : undefined;
    expect(dataAssetDependencies("DataDefinition", parent, [], resolve)).toEqual(["child", "texture"]);
    expect(dataAssetDependencies("DataTree", payload, [], resolve)).toEqual(["parent", "texture"]);
    const results = remapImportResultGuids([
      imported("DataDefinition", "parent", parent), imported("DataDefinition", "child", child),
      imported("DataTree", "tree", payload), imported("Texture", "texture", {}),
    ], new Set(["child", "texture"]));
    const mapped = { Icon: results[3]!.guid, Caption: "texture" };
    expect(body(results[0]!)).toMatchObject({ fields: [
      { typeClassId: results[1]!.guid, defaultValue: mapped },
      { keyTypeClassId: results[1]!.guid, defaultValue: [{ key: mapped, value: "texture" }] },
    ] });
    expect(body(results[2]!)).toMatchObject({ entries: [{ id: "texture", parentId: null, name: "texture", values: { Child: mapped, Keys: [{ key: mapped, value: "texture" }] } }] });
    const cleared = { Icon: "", Caption: "texture" };
    expect(clearDeletedAssetRefs(parent, new Set(["texture"]), new Set(), resolve).value.fields)
      .toMatchObject([{ defaultValue: cleared }, { defaultValue: [{ key: cleared, value: "texture" }] }]);
    expect(clearDeletedAssetRefs(payload, new Set(["texture"]), new Set(), resolve).value.entries)
      .toMatchObject([{ id: "texture", parentId: null, name: "texture", values: { Child: cleared, Keys: [{ key: cleared, value: "texture" }] } }]);
  });

  it.each(["Icon", "Portrait"])("retains nested default references before and after saving a stable rename (%s)", (authoredName) => {
    const child = { kind: "dataDefinition", fields: [
      { id: "icon", name: "Portrait", typeId: "asset", typeClassId: "Texture" },
      { id: "caption", name: "Caption", typeId: "string" },
    ] };
    // Persisted snapshots before/after default reconciliation retain the removed
    // field and keep the stable identity of Icon when it becomes Portrait.
    const savedFields = [
      { id: "icon", name: authoredName, typeId: "asset", typeClassId: "Texture" },
      { id: "caption", name: "Caption", typeId: "string" },
      { id: "retired", name: "Retired", typeId: "asset", typeClassId: "Texture" },
    ];
    const value = { [authoredName]: "texture", Caption: "retired-texture", Retired: "retired-texture" };
    const parent = { kind: "dataDefinition", fields: [
      { id: "child", name: "Child", typeId: "struct", typeClassId: "child", fields: savedFields, defaultValue: value },
      { id: "items", name: "Items", typeId: "struct", typeClassId: "child", container: "array", fields: savedFields, defaultValue: [value] },
      { id: "map", name: "Map", typeId: "struct", typeClassId: "child", container: "map", keyTypeId: "struct", keyTypeClassId: "child", fields: savedFields, keyFields: savedFields, defaultValue: [{ key: value, value }] },
    ] };
    const resolve = (guid: string) => guid === "child" ? child.fields : undefined;
    expect(dataAssetDependencies("DataDefinition", parent, [], resolve)).toEqual(["child", "retired-texture", "texture"]);

    const results = remapImportResultGuids([
      imported("DataDefinition", "parent", parent), imported("DataDefinition", "child", child),
      imported("Texture", "texture", {}), imported("Texture", "retired-texture", {}),
    ], new Set(["child", "texture", "retired-texture"]));
    const mapped = { [authoredName]: results[2]!.guid, Caption: "retired-texture", Retired: results[3]!.guid };
    expect(body(results[0]!)).toMatchObject({ fields: [
      { id: "child", typeClassId: results[1]!.guid, fields: savedFields, defaultValue: mapped },
      { id: "items", typeClassId: results[1]!.guid, fields: savedFields, defaultValue: [mapped] },
      { id: "map", typeClassId: results[1]!.guid, keyTypeClassId: results[1]!.guid, fields: savedFields, keyFields: savedFields, defaultValue: [{ key: mapped, value: mapped }] },
    ] });

    const cleared = { [authoredName]: "", Caption: "retired-texture", Retired: "" };
    expect(clearDeletedAssetRefs(parent, new Set(["texture", "retired-texture"]), new Set(), resolve).value.fields)
      .toMatchObject([{ defaultValue: cleared }, { defaultValue: [cleared] }, { defaultValue: [{ key: cleared, value: cleared }] }]);
    expect(parent.fields[0]!.defaultValue).toEqual(value);
  });

  it("clears typed references and Class values while preserving every owned entry and ordinary string", () => {
    const source = tree();
    const cleared = clearDeletedAssetRefs(source, new Set(["texture", "weapon", "stats", "grade"]));
    expect(cleared.value).toMatchObject({ defaultDefinitionGuid: null, entries: [{ id: "texture", parentId: null, name: "hero", values: {
      Label: "texture", assetGuid: "texture", Icon: "", Stats: { Portrait: "", Caption: "texture", Grade: "Common" },
    } }] });
    expect(cleared.value.entries[0]!.schema[6]).not.toHaveProperty("typeClassId");
    const hero = { guid: "hero", classId: "Hero" };
    expect(findClassAssetReferences(source, [hero])).toEqual(["hero"]);
    const replaced = replaceClassAssetReferences(source, [{ ...hero, replacement: { guid: "npc", classId: "NPC" } }]);
    expect(replaced.value.entries[0]).toMatchObject({ id: "texture", parentId: null, name: "hero", values: { Spawn: "NPC", ClassText: "Hero", ClassGuidText: "hero" } });
    expect(replaced.value.entries[0]!.schema[5]!.typeClassId).toBe("NPC");
    expect(clearDeletedAssetRefs(source, new Set(["hero"]), new Set(["Hero"])).value.entries[0]!.values)
      .toMatchObject({ Spawn: "", ClassText: "Hero", ClassGuidText: "hero" });
    expect(source.entries[0]!.values.Icon).toBe("texture");
    expect(clearDeletedAssetRefs(source, new Set(["unrelated"])).value).toBe(source);
  });

  it("traverses typed containers and nested map keys while preserving text, tags, and array positions", () => {
    const row = { id: "row", parentId: null, name: "Entry", values: {
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
    const payload = { kind: "dataTree", defaultDefinitionGuid: "inventory", entries: [row] };
    expect(dataAssetDependencies("DataTree", payload, [{ guid: "hero", classId: "Hero" }])).toEqual(["hero", "inventory", "keep", "stats", "texture"]);
    const mapped = remapImportResultGuids([imported("DataTree", "inventory-tree", payload), imported("Texture", "texture", {}), imported("Structure", "stats", {})], new Set(["texture", "stats"]));
    expect(body(mapped[0]!).entries).toMatchObject([{ values: { Icons: [mapped[1]!.guid, "keep", mapped[1]!.guid], ByStats: [{ key: { Icon: mapped[1]!.guid, Caption: "texture" }, value: "texture" }], Tags: ["texture", "hero"] }, schema: [{}, {}, { keyTypeClassId: mapped[2]!.guid }, {}, {}, {}] }]);
    expect(clearDeletedAssetRefs(payload, new Set(["texture"]), new Set(["Hero"])).value.entries[0]!.values).toEqual({
      Icons: ["", "keep", ""], ByAsset: [{ key: "keep", value: "texture" }],
      ByStats: [{ key: { Icon: "", Caption: "texture" }, value: "texture" }],
      Actors: ["", "Keep"], Tags: ["texture", "hero"], ByClass: [{ key: "Keep", value: "" }],
    });
  });

  it("tracks graph assets and typed literals without treating entry paths as assets", () => {
    const props = { definitionGuid: "weapon", "default:tree": "tree", "default:entryPath": "texture", "default:name": "texture", dataSchema: [
      { name: "Icon", typeId: "asset", typeClassId: "Texture" },
      { name: "Metadata", typeId: "struct", typeClassId: "metadata", fields: [{ name: "Name", typeId: "string" }, { name: "Asset", typeId: "string" }] },
    ], "default:values": { Icon: "texture", Metadata: { Name: "Label", Asset: "texture" } } };
    const graph = { nodes: [
      { type: "editorData.updateEntry", data: { properties: props } },
      { type: "data.readEntry", data: { properties: { definitionGuid: "weapon", "default:tree": "tree", "default:entryPath": "unused" } } },
      { type: "editorData.reorderChildren", data: { properties: { "default:tree": "tree", "default:entryPaths": ["texture", "unused"] } } },
      { type: "editorData.moveEntry", data: { properties: { "default:tree": "tree", "default:entryPath": "Branch/texture", "default:newParentPath": "texture" } } },
    ] };
    expect(dataGraphAssetDependencies(graph)).toEqual(["metadata", "texture", "tree", "weapon"]);
    const mapped = remapImportResultGuids([imported("Class", "class", graph), imported("Texture", "texture", {})], new Set(["texture"]));
    expect(body(mapped[0]!).nodes).toMatchObject([{ data: { properties: { "default:entryPath": "texture", "default:name": "texture", "default:values": { Icon: mapped[1]!.guid, Metadata: { Name: "Label", Asset: "texture" } } } } }, {}, { data: { properties: { "default:entryPaths": ["texture", "unused"] } } }, { data: { properties: { "default:entryPath": "Branch/texture", "default:newParentPath": "texture" } } }]);
    const cleared = clearDeletedAssetRefs(graph, new Set(["texture"])).value;
    expect(cleared.nodes[0]!.data.properties).toMatchObject({ "default:entryPath": "texture", "default:name": "texture", "default:values": { Icon: "", Metadata: { Name: "Label", Asset: "texture" } } });
    expect(cleared.nodes[2]!.data.properties).toMatchObject({ "default:entryPaths": ["texture", "unused"] });
    expect(cleared.nodes[3]!.data.properties).toMatchObject({ "default:entryPath": "Branch/texture", "default:newParentPath": "texture" });
    const replaced = replaceClassAssetReferences(graph, [{ guid: "texture", classId: "Legacy", replacement: null }]).value;
    expect(replaced.nodes[0]!.data.properties)
      .toMatchObject({ "default:entryPath": "texture", "default:name": "texture", "default:values": { Icon: "" } });
    expect(replaced.nodes[2]!.data.properties).toMatchObject({ "default:entryPaths": ["texture", "unused"] });
  });

  it("preserves unsupported historical bodies instead of reinterpreting them as definitions or trees", () => {
    const legacyObject = { kind: "dataObject", structureGuid: "old", values: { Label: "texture" } };
    const legacySheet = { kind: "dataSheet", structureGuid: "old", objectGuids: ["texture"] };
    const ownedSheet = { kind: "dataSheet", definitionGuid: "old", rows: [{ id: "row", name: "Row", values: { Icon: "texture" }, schema: [{ name: "Icon", typeId: "asset" }] }] };
    expect(clearDeletedAssetRefs(legacyObject, new Set(["texture", "old"])).value).toBe(legacyObject);
    expect(clearDeletedAssetRefs(legacySheet, new Set(["texture", "old"])).value).toBe(legacySheet);
    expect(clearDeletedAssetRefs(ownedSheet, new Set(["texture", "old"])).value).toBe(ownedSheet);
    const imports = [imported("DataObject", "texture", legacyObject), imported("DataSheet", "old-sheet", legacySheet), imported("DataSheet", "owned-sheet", ownedSheet)];
    expect(remapImportResultGuids(imports, new Set())).toBe(imports);
    expect(() => remapImportResultGuids(imports, new Set(["texture"]))).toThrow(/Historical/);
    expect(body(imports[0]!)).toEqual(legacyObject);
  });
});
