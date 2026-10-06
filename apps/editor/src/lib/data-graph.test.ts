import { describe, expect, it, vi } from "vitest";
import type { SerializedGraph } from "@babylonslate/core";
import { applyDataGraphAssetPicks, collectDataGraphAssets, dataGraphAssetCreateOptions, dataGraphAssetPickPatch, patchDataGraphNode } from "./data-graph";
import { dataNodePropertyRows, variableAssetPickerAllowedTypes } from "./graph-inspector";

describe("Data graph catalog and Inspector", () => {
  const assets = [
    { path: "assets/sword.babasset", header: { guid: "sword", type: "DataObject", name: "Sword", payload: { structureGuid: "weapon" } } },
    { path: "assets/items.babasset", header: { guid: "items", type: "DataSheet", name: "Items", payload: { structureGuid: "weapon" } } },
    { path: "assets/icon.babasset", header: { guid: "icon", type: "Texture", name: "Icon" } },
  ];

  it("uses unsaved object schemas while retaining stable asset identities", () => {
    const catalog = collectDataGraphAssets(assets, [
      { ref: { path: "assets/sword.babasset" }, content: { structureGuid: "armor" } },
    ]);
    expect(catalog).toEqual([
      { guid: "sword", name: "Sword", type: "DataObject", structureGuid: "armor" },
      { guid: "items", name: "Items", type: "DataSheet", structureGuid: "weapon" },
    ]);
    expect(dataGraphAssetPickPatch("data.readObject", "object", "sword", catalog, { structGuid: "weapon" }))
      .toMatchObject({ "default:object": "sword", structGuid: "armor", "default:values": undefined, dataSchema: undefined });
    expect(dataGraphAssetPickPatch("data.readObject", "object", null, catalog, { structGuid: "weapon" }))
      .toEqual({ "default:object": "" });
  });

  it.each([
    ["data.readObject", "object"],
    ["data.getSheetObjects", "sheet"],
    ["editorData.updateObject", "object"],
    ["editorData.setSheetObjects", "sheet"],
  ])("creates a matching asset for the %s %s input", (typeId, pinId) => {
    expect(dataGraphAssetCreateOptions(typeId, pinId, { structGuid: " weapon " })).toEqual({ structureGuid: "weapon" });
  });

  it("keeps a node's Structure out of nested references and unrelated asset pickers", () => {
    const properties = { structGuid: "weapon" };
    expect(dataGraphAssetCreateOptions("editorData.updateObject", "values:Loot", properties)).toBeUndefined();
    expect(dataGraphAssetCreateOptions("editorData.createObject", "object", properties)).toBeUndefined();
    expect(dataGraphAssetCreateOptions("data.readObject", "sheet", properties)).toBeUndefined();
    expect(dataGraphAssetCreateOptions("scene-layer.registerPostProcess", "material", properties)).toBeUndefined();
    expect(dataGraphAssetCreateOptions("data.readObject", "object", { structGuid: "  " })).toBeUndefined();
    expect(dataGraphAssetCreateOptions("data.readObject", "object", { structGuid: 12 })).toBeUndefined();
  });

  it("infers a changed inline reference's Structure and clears only the previous typed literal", () => {
    const before: SerializedGraph = { nodes: [{ id: "update", type: "editorData.updateObject", position: { x: 0, y: 0 }, data: {
      structGuid: "armor", "default:object": "helmet", "default:values": { Defense: 20 }, "default:name": "Preserved",
      dataSchema: [{ id: "defense", name: "Defense", typeId: "float" }],
    } }], edges: [] };
    const next: SerializedGraph = { ...before, nodes: [{ ...before.nodes[0]!, data: { ...before.nodes[0]!.data, "default:object": "sword" } }] };
    const edited = applyDataGraphAssetPicks(before, next, collectDataGraphAssets(assets));
    expect(edited.nodes[0]?.data).toEqual({
      structGuid: "weapon", "default:object": "sword", "default:values": undefined, "default:name": "Preserved", dataSchema: undefined,
    });
    expect(next.nodes[0]?.data.structGuid).toBe("armor");
    const manual = { ...before, nodes: [{ ...before.nodes[0]!, data: { ...before.nodes[0]!.data, structGuid: "weapon" } }] };
    expect(applyDataGraphAssetPicks(before, manual, collectDataGraphAssets(assets))).toBe(manual);
  });

  it("does not infer from stale wired defaults or clear a type when an inline reference is removed", () => {
    const before: SerializedGraph = { nodes: [{ id: "read", type: "data.readObject", position: { x: 0, y: 0 }, data: { structGuid: "armor", "default:object": "helmet" } }], edges: [] };
    const next = { ...before, nodes: [{ ...before.nodes[0]!, data: { ...before.nodes[0]!.data, "default:object": "sword" } }],
      edges: [{ id: "wire", source: "source", sourceHandle: "value", target: "read", targetHandle: "object" }] };
    expect(applyDataGraphAssetPicks(before, next, collectDataGraphAssets(assets))).toBe(next);
    const cleared = { ...before, nodes: [{ ...before.nodes[0]!, data: { ...before.nodes[0]!.data, "default:object": "" } }] };
    expect(applyDataGraphAssetPicks(before, cleared, collectDataGraphAssets(assets))).toBe(cleared);
  });

  it("changes the Structure without discarding independent asset, name and folder inputs", () => {
    const patch = vi.fn();
    const current = { structGuid: "armor", "default:values": { Defense: 20 }, "default:object": "sword", "default:name": "Sword", "default:folder": "items" };
    const row = dataNodePropertyRows("editorData.updateObject", current, patch, [{ guid: "weapon", name: "Weapon" }])[0]!;
    if (row.kind !== "enum") throw new Error("Expected a Structure selector");
    row.onChange("weapon");
    expect(patch.mock.calls[0]?.[0]).toEqual({ structGuid: "weapon", title: "Update Weapon Data", "default:values": undefined, dataSchema: undefined });
    expect({ ...current, ...patch.mock.calls[0]?.[0] }).toMatchObject({ "default:object": "sword", "default:name": "Sword", "default:folder": "items" });
    row.onChange("");
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it("allows clearing optional sheet filters and preserves defaults when the Structure stays the same", () => {
    const patch = vi.fn();
    const row = dataNodePropertyRows("data.getSheetObjects", { structGuid: "weapon" }, patch, [{ guid: "weapon", name: "Weapon" }])[0]!;
    if (row.kind !== "enum") throw new Error("Expected a Structure selector");
    row.onChange("weapon");
    expect(patch.mock.calls[0]?.[0]).toEqual({ structGuid: "weapon", title: "Get Weapon Data Objects" });
    row.onChange("");
    expect(patch.mock.calls[1]?.[0]).toMatchObject({ structGuid: "", title: "Get Data Sheet Objects" });
  });

  it("lets generic asset variables select standalone objects and sheets", () => {
    expect(variableAssetPickerAllowedTypes(undefined)).toEqual(expect.arrayContaining(["DataObject", "DataSheet"]));
    expect(variableAssetPickerAllowedTypes("DataObject")).toEqual(["DataObject"]);
    expect(variableAssetPickerAllowedTypes("DataSheet")).toEqual(["DataSheet"]);
  });

  it("edits a function's data node and retains removed values plus their authored schema", () => {
    const selected = { id: "write", type: "editorData.updateObject", position: { x: 0, y: 0 }, data: {
      structGuid: "weapon", dataSchema: [{ id: "old", name: "RemovedIcon", typeId: "asset", typeClassId: "Texture" }],
      "default:values": { Damage: 10, RemovedIcon: "texture" },
    } };
    const graph: SerializedGraph = { nodes: [], edges: [], functionGraphs: { build: { nodes: [selected], edges: [] } } };
    const next = patchDataGraphNode(graph, selected, { "default:values": { Damage: 25 } }, "build");
    expect(next.nodes).toBe(graph.nodes);
    expect(next.functionGraphs?.build?.nodes[0]?.data).toMatchObject({
      structGuid: "weapon", dataSchema: [{ id: "old", name: "RemovedIcon", typeId: "asset", typeClassId: "Texture" }],
      "default:values": { Damage: 25, RemovedIcon: "texture" },
    });
    expect(graph.functionGraphs?.build?.nodes[0]?.data["default:values"]).toEqual({ Damage: 10, RemovedIcon: "texture" });
  });
});
