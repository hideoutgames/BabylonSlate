import { describe, expect, it, vi } from "vitest";
import type { SerializedGraph } from "@babylonslate/core";
import { applyDataGraphAssetPicks, collectDataGraphAssets, dataGraphAssetCreateOptions, dataGraphAssetPickPatch, patchDataGraphNode } from "./data-graph";
import { dataNodePropertyRows, dataNodeRowOptions, variableAssetPickerAllowedTypes } from "./graph-inspector";

describe("Data graph catalog and Inspector", () => {
  const assets = [
    { path: "assets/sword.babasset", header: { guid: "sword", type: "DataSheet", name: "Sword", payload: { definitionGuid: "weapon" } } },
    { path: "assets/items.babasset", header: { guid: "items", type: "DataSheet", name: "Items", payload: { definitionGuid: "weapon" } } },
    { path: "assets/icon.babasset", header: { guid: "icon", type: "Texture", name: "Icon" } },
  ];

  it("uses unsaved sheet schemas while retaining stable asset identities", () => {
    const catalog = collectDataGraphAssets(assets, [
      { ref: { path: "assets/sword.babasset" }, content: { definitionGuid: "armor" } },
    ]);
    expect(catalog).toEqual([
      { guid: "sword", name: "Sword", type: "DataSheet", definitionGuid: "armor", rows: [] },
      { guid: "items", name: "Items", type: "DataSheet", definitionGuid: "weapon", rows: [] },
    ]);
    expect(dataGraphAssetPickPatch("data.readRow", "sheet", "sword", catalog, { definitionGuid: "weapon" }))
      .toMatchObject({ "default:sheet": "sword", definitionGuid: "armor", "default:values": undefined, dataSchema: undefined });
    expect(dataGraphAssetPickPatch("data.readRow", "sheet", null, catalog, { definitionGuid: "weapon" }))
      .toEqual({ "default:sheet": "" });
  });

  it.each([
    ["data.readRow", "sheet"],
    ["data.getSheetRows", "sheet"],
    ["editorData.updateRow", "sheet"],
    ["editorData.reorderRows", "sheet"],
  ])("creates a matching asset for the %s %s input", (typeId, pinId) => {
    expect(dataGraphAssetCreateOptions(typeId, pinId, { definitionGuid: " weapon " })).toEqual({ definitionGuid: "weapon" });
  });

  it("keeps a node's Data Definition out of nested references and unrelated asset pickers", () => {
    const properties = { definitionGuid: "weapon" };
    expect(dataGraphAssetCreateOptions("editorData.updateRow", "values:Loot", properties)).toBeUndefined();
    expect(dataGraphAssetCreateOptions("editorData.createSheet", "sheet", properties)).toBeUndefined();
    expect(dataGraphAssetCreateOptions("data.readRow", "values:Sheet", properties)).toBeUndefined();
    expect(dataGraphAssetCreateOptions("scene-layer.registerPostProcess", "material", properties)).toBeUndefined();
    expect(dataGraphAssetCreateOptions("data.readRow", "sheet", { definitionGuid: "  " })).toBeUndefined();
    expect(dataGraphAssetCreateOptions("data.readRow", "sheet", { definitionGuid: 12 })).toBeUndefined();
  });

  it("infers a changed inline reference's Data Definition and clears only the previous typed literal", () => {
    const before: SerializedGraph = { nodes: [{ id: "update", type: "editorData.updateRow", position: { x: 0, y: 0 }, data: {
      definitionGuid: "armor", "default:sheet": "helmet", "default:values": { Defense: 20 }, "default:name": "Preserved",
      dataSchema: [{ id: "defense", name: "Defense", typeId: "float" }],
    } }], edges: [] };
    const next: SerializedGraph = { ...before, nodes: [{ ...before.nodes[0]!, data: { ...before.nodes[0]!.data, "default:sheet": "sword" } }] };
    const edited = applyDataGraphAssetPicks(before, next, collectDataGraphAssets(assets));
    expect(edited.nodes[0]?.data).toEqual({
      definitionGuid: "weapon", "default:sheet": "sword", "default:values": undefined, "default:name": "Preserved", dataSchema: undefined,
    });
    expect(next.nodes[0]?.data.definitionGuid).toBe("armor");
    const manual = { ...before, nodes: [{ ...before.nodes[0]!, data: { ...before.nodes[0]!.data, definitionGuid: "weapon" } }] };
    expect(applyDataGraphAssetPicks(before, manual, collectDataGraphAssets(assets))).toBe(manual);
  });

  it("does not infer from stale wired defaults or clear a type when an inline reference is removed", () => {
    const before: SerializedGraph = { nodes: [{ id: "read", type: "data.readRow", position: { x: 0, y: 0 }, data: { definitionGuid: "armor", "default:sheet": "helmet" } }], edges: [] };
    const next = { ...before, nodes: [{ ...before.nodes[0]!, data: { ...before.nodes[0]!.data, "default:sheet": "sword" } }],
      edges: [{ id: "wire", source: "source", sourceHandle: "value", target: "read", targetHandle: "sheet" }] };
    expect(applyDataGraphAssetPicks(before, next, collectDataGraphAssets(assets))).toBe(next);
    const cleared = { ...before, nodes: [{ ...before.nodes[0]!, data: { ...before.nodes[0]!.data, "default:sheet": "" } }] };
    expect(applyDataGraphAssetPicks(before, cleared, collectDataGraphAssets(assets))).toBe(cleared);
  });

  it("changes the Data Definition without discarding independent asset, name and folder inputs", () => {
    const patch = vi.fn();
    const current = { definitionGuid: "armor", "default:values": { Defense: 20 }, "default:sheet": "sword", "default:name": "Sword", "default:folder": "items" };
    const row = dataNodePropertyRows("editorData.updateRow", current, patch, [{ guid: "weapon", name: "Weapon" }])[0]!;
    if (row.kind !== "enum") throw new Error("Expected a Data Definition selector");
    row.onChange("weapon");
    expect(patch.mock.calls[0]?.[0]).toEqual({ definitionGuid: "weapon", title: "Update Weapon Data", "default:values": undefined, dataSchema: undefined });
    expect({ ...current, ...patch.mock.calls[0]?.[0] }).toMatchObject({ "default:sheet": "sword", "default:name": "Sword", "default:folder": "items" });
    row.onChange("");
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it("allows clearing optional sheet filters and preserves defaults when the Data Definition stays the same", () => {
    const patch = vi.fn();
    const row = dataNodePropertyRows("data.getSheetRows", { definitionGuid: "weapon" }, patch, [{ guid: "weapon", name: "Weapon" }])[0]!;
    if (row.kind !== "enum") throw new Error("Expected a Data Definition selector");
    row.onChange("weapon");
    expect(patch.mock.calls[0]?.[0]).toEqual({ definitionGuid: "weapon", title: "Get Weapon Data Rows" });
    row.onChange("");
    expect(patch.mock.calls[1]?.[0]).toMatchObject({ definitionGuid: "", title: "Get Data Sheet Rows" });
  });

  it("lets generic asset variables select definitions and sheets", () => {
    expect(variableAssetPickerAllowedTypes(undefined)).toEqual(expect.arrayContaining(["DataDefinition", "DataSheet"]));
    expect(variableAssetPickerAllowedTypes("DataDefinition")).toEqual(["DataDefinition"]);
    expect(variableAssetPickerAllowedTypes("DataSheet")).toEqual(["DataSheet"]);
  });

  it("edits a function's data node and retains removed values plus their authored schema", () => {
    const selected = { id: "write", type: "editorData.updateRow", position: { x: 0, y: 0 }, data: {
      definitionGuid: "weapon", dataSchema: [{ id: "old", name: "RemovedIcon", typeId: "asset", typeClassId: "Texture" }],
      "default:values": { Damage: 10, RemovedIcon: "texture" },
    } };
    const graph: SerializedGraph = { nodes: [], edges: [], functionGraphs: { build: { nodes: [selected], edges: [] } } };
    const next = patchDataGraphNode(graph, selected, { "default:values": { Damage: 25 } }, "build");
    expect(next.nodes).toBe(graph.nodes);
    expect(next.functionGraphs?.build?.nodes[0]?.data).toMatchObject({
      definitionGuid: "weapon", dataSchema: [{ id: "old", name: "RemovedIcon", typeId: "asset", typeClassId: "Texture" }],
      "default:values": { Damage: 25, RemovedIcon: "texture" },
    });
    expect(graph.functionGraphs?.build?.nodes[0]?.data["default:values"]).toEqual({ Damage: 10, RemovedIcon: "texture" });
  });
  it("offers row names from the literal sheet and persists stable IDs through row renames", () => {
    const sheets = [{ guid: "items", name: "Items", type: "DataSheet" as const, definitionGuid: "weapon", rows: [{ id: "row-1", name: "Renamed Sword" }] }];
    const patch = vi.fn();
    const current = { definitionGuid: "weapon", "default:sheet": "items", "default:rowId": "row-1" };
    const rows = dataNodePropertyRows("data.readRow", current, patch, [{ guid: "weapon", name: "Weapon" }], sheets);
    const row = rows.find((entry) => entry.id === "default:rowId");
    if (row?.kind !== "enum") throw new Error("Expected a row picker");
    expect(row.value).toBe("row-1");
    expect(row.options).toContainEqual({ value: "row-1", label: "Renamed Sword" });
    row.onChange("row-1");
    expect(patch).toHaveBeenCalledWith({ "default:rowId": "row-1" });
    expect(dataNodeRowOptions("data.readRow", current, sheets, (pin) => pin === "rowId")).toBeUndefined();
    expect(dataNodeRowOptions("data.readRow", current, sheets, (pin) => pin === "sheet")).toBeUndefined();
  });

});
