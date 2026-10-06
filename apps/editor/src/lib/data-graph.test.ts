import { describe, expect, it, vi } from "vitest";
import type { SerializedGraph } from "@babylonslate/core";
import { applyDataGraphAssetPicks, collectDataGraphAssets, dataGraphAssetCreateOptions, dataGraphAssetPickPatch, patchDataGraphNode } from "./data-graph";
import { dataNodePropertyRows, dataNodePathOptions, variableAssetPickerAllowedTypes } from "./graph-inspector";

const entries = [
  { id: "weapons", parentId: null, name: "Weapons", values: {} },
  { id: "sword", parentId: "weapons", name: "Sword", values: { Damage: 10 } },
  { id: "armor", parentId: null, name: "Armor", definitionGuid: "armor", values: {} },
];
const assets = [{ path: "assets/items.babasset", header: { guid: "items", type: "DataTree", name: "Items", payload: { defaultDefinitionGuid: "weapon", entries } } }];
const catalog = collectDataGraphAssets(assets);

describe("Data Tree graph catalog and Inspector", () => {
  it("indexes exact hierarchical paths and effective Definitions from unsaved trees", () => {
    expect(catalog[0]?.entries).toEqual([
      { id: "weapons", path: "Weapons", parentPath: "", effectiveDefinitionGuid: "weapon" },
      { id: "sword", path: "Weapons/Sword", parentPath: "Weapons", effectiveDefinitionGuid: "weapon" },
      { id: "armor", path: "Armor", parentPath: "", effectiveDefinitionGuid: "armor" },
    ]);
    expect(catalog[0]?.defaultDefinitionGuid).toBe("weapon");
    const changed = collectDataGraphAssets(assets, [{ ref: { path: assets[0]!.path }, content: {
      defaultDefinitionGuid: "weapon", entries: entries.map((entry) => entry.id === "weapons" ? { ...entry, name: "Equipment", definitionGuid: null } : entry),
    } }]);
    expect(changed[0]?.entries[1]).toMatchObject({ id: "sword", path: "Equipment/Sword", effectiveDefinitionGuid: null });
    expect(collectDataGraphAssets(assets, [{ ref: { path: assets[0]!.path }, content: { defaultDefinitionGuid: null, entries: [{ ...entries[0], parentId: "sword" }, entries[1]] } }])[0]?.invalid).toBe(true);
  });

  it("infers the selected entry schema only after an exact path resolves", () => {
    const current = { "default:tree": "items", "default:entryPath": "Weapons/Sword", definitionGuid: "weapon", "default:values": { Damage: 20 } };
    expect(dataGraphAssetPickPatch("data.readEntry", "entryPath", "Armor", catalog, current)).toMatchObject({ definitionGuid: "armor", "default:entryPath": "Armor", "default:values": undefined });
    expect(dataGraphAssetPickPatch("data.readEntry", "tree", "items", catalog, { "default:entryPath": "Weapons/Sword" })).toMatchObject({ definitionGuid: "weapon" });
    expect(dataGraphAssetPickPatch("data.readEntry", "tree", "items", catalog)).toEqual({ "default:tree": "items" });
    expect(dataGraphAssetPickPatch("data.readEntry", "entryPath", "sword", catalog, current)).toEqual({ "default:entryPath": "sword" });
    expect(dataGraphAssetPickPatch("data.getChildren", "entryPath", "Armor", catalog, current)).toEqual({ "default:entryPath": "Armor" });
    expect(dataGraphAssetPickPatch("data.readEntry", "tree", "items", catalog,
      { ...current, "default:entryPath": "Armor" }, (pin) => pin === "entryPath")).toEqual({ "default:tree": "items" });
  });

  it("creates a tree with a default Definition only from its primary asset picker", () => {
    const props = { definitionGuid: "weapon" };
    expect(dataGraphAssetCreateOptions("data.readEntry", "tree", props)).toEqual({ defaultDefinitionGuid: "weapon" });
    expect(dataGraphAssetCreateOptions("editorData.updateEntry", "values:OtherTree", props)).toBeUndefined();
    expect(dataGraphAssetCreateOptions("data.readEntry", "tree", { definitionGuid: " " })).toBeUndefined();
    expect(dataGraphAssetCreateOptions("editorData.addEntry", "tree", { definitionGuid: "weapon", definitionMode: "none" })).toBeUndefined();
    expect(variableAssetPickerAllowedTypes("DataTree")).toEqual(["DataTree"]);
  });

  it("commits inline path selection with schema inference but ignores stale connected defaults", () => {
    const previous: SerializedGraph = { nodes: [{ id: "read", type: "data.readEntry", position: { x: 0, y: 0 }, data: {
      "default:tree": "items", "default:entryPath": "Weapons/Sword", definitionGuid: "weapon",
    } }], edges: [] };
    const next = { ...previous, nodes: previous.nodes.map((node) => ({ ...node, data: { ...node.data, "default:entryPath": "Armor" } })) };
    expect(applyDataGraphAssetPicks(previous, next, catalog).nodes[0]?.data.definitionGuid).toBe("armor");
    const wired = { ...next, edges: [{ id: "input", source: "source", sourceHandle: "value", target: "read", targetHandle: "entryPath" }] };
    expect(applyDataGraphAssetPicks(previous, wired, catalog).nodes[0]?.data.definitionGuid).toBe("weapon");
  });

  it("offers root only for navigation and falls back to text for absent or wired trees", () => {
    const current = { "default:tree": "items", "default:entryPath": "Weapons/Sword" };
    expect(dataNodePathOptions("data.readEntry", "entryPath", current, catalog)).toMatchObject({ includeRoot: false, entries: catalog[0]!.entries });
    expect(dataNodePathOptions("data.getChildren", "entryPath", current, catalog)?.includeRoot).toBe(true);
    expect(dataNodePathOptions("data.readEntry", "entryPath", {}, catalog)).toBeUndefined();
    expect(dataNodePathOptions("data.readEntry", "entryPath", current, catalog, (pin) => pin === "tree")).toBeUndefined();
    expect(dataNodePathOptions("data.readEntry", "entryPath", current, catalog, (pin) => pin === "entryPath")).toBeUndefined();
    expect(dataNodePropertyRows("data.getChildren", current, vi.fn(), [])).toEqual([]);
    const patch = vi.fn();
    const modes = dataNodePropertyRows("editorData.addEntry", current, patch, []);
    const mode = modes.find((row) => row.id === "definitionMode");
    if (mode?.kind !== "enum") throw new Error("Expected Definition mode");
    mode.onChange("none");
    expect(patch).toHaveBeenCalledWith({ definitionMode: "none" });
  });

  it("edits function data values while retaining unknown authored references and snapshots", () => {
    const selected = { id: "write", type: "editorData.updateEntry", position: { x: 0, y: 0 }, data: {
      definitionGuid: "weapon", dataSchema: [{ id: "old", name: "RemovedIcon", typeId: "asset", typeClassId: "Texture" }],
      "default:values": { Damage: 10, RemovedIcon: "texture" },
    } };
    const graph: SerializedGraph = { nodes: [], edges: [], functionGraphs: { build: { nodes: [selected], edges: [] } } };
    const next = patchDataGraphNode(graph, selected, { "default:values": { Damage: 25 } }, "build");
    expect(next.functionGraphs?.build?.nodes[0]?.data).toMatchObject({ definitionGuid: "weapon", dataSchema: selected.data.dataSchema, "default:values": { Damage: 25, RemovedIcon: "texture" } });
    expect(selected.data["default:values"].Damage).toBe(10);
  });
});
