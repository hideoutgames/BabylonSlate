import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@babylonslate/core";
import type { TypeSchemas } from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { hydrateSerializedGraphForEditor, materializeLogicGraph, scriptPaletteNodes, validateSerializedGraph } from "./graph-validation";
import type { DataGraphAssetEntry } from "../lib/data-graph";

const structures: TypeSchemas["structs"] = {
  weapon: { name: "Weapon", fields: [{ id: "damage", name: "Damage", typeId: "float", defaultValue: 10 }] },
  armor: { name: "Armor", fields: [{ id: "defense", name: "Defense", typeId: "float", defaultValue: 20 }] },
};
const dataAssets: DataGraphAssetEntry[] = [
  { guid: "sword", name: "Sword", type: "DataSheet", definitionGuid: "weapon" },
  { guid: "helmet", name: "Helmet", type: "DataSheet", definitionGuid: "armor" },
  { guid: "weapons", name: "Weapons", type: "DataSheet", definitionGuid: "weapon" },
];
const node = (id: string, type: string, data: Record<string, unknown> = {}): SerializedGraph["nodes"][number] => ({ id, type, position: { x: 0, y: 0 }, data });
const options = { assetGuid: "class", graphId: "graph", structs: structures, dataDefinitions: structures, dataAssets };

describe("Data graph integration", () => {
  it("offers typed read nodes and keeps editor writes on editor utility hosts", () => {
    const registry = createDefaultNodeRegistry();
    const catalog = { dataDefinitions: [{ guid: "weapon", ...structures.weapon! }] };
    const game = scriptPaletteNodes(registry, { ...catalog, parentClass: "Actor" });
    const read = game.find((entry) => entry.id === "data.readRow:weapon");
    expect(read?.title).toBe("Read Weapon Data");
    expect(read?.pins?.find((pin) => pin.id === "value")?.type).toEqual({ kind: "structRef", guid: "weapon" });
    expect(game.find((entry) => entry.id === "struct.break:weapon")?.title).toBe("Break Weapon Data");
    expect(game.some((entry) => entry.id.startsWith("editorData."))).toBe(false);
    const editor = scriptPaletteNodes(registry, { ...catalog, parentClass: "EditorUtilityObject" });
    expect(editor.find((entry) => entry.id === "editorData.updateRow:weapon")?.pins?.find((pin) => pin.id === "values")?.type)
      .toEqual({ kind: "structRef", guid: "weapon" });
  });

  it("infers an unwired literal's Data Definition and refreshes stale pins without losing compatible wires", () => {
    const graph: SerializedGraph = {
      nodes: [
        node("read", "data.readRow", { "default:sheet": "sword", __pins: [{ id: "value", direction: "out", kind: "data", type: { kind: "structRef", guid: "armor" } }] }),
        node("weapon", "struct.break", { structGuid: "weapon" }),
        node("armor", "struct.break", { structGuid: "armor" }),
        node("branch", "flow.branch"),
      ],
      edges: [
        { id: "compatible", source: "read", sourceHandle: "value", target: "weapon", targetHandle: "in" },
        { id: "incompatible", source: "read", sourceHandle: "value", target: "armor", targetHandle: "in" },
        { id: "found", source: "read", sourceHandle: "found", target: "branch", targetHandle: "condition" },
      ],
    };
    const hydrated = hydrateSerializedGraphForEditor(graph, undefined, options);
    expect(hydrated.nodes[0]?.data).toMatchObject({ definitionGuid: "weapon", title: "Read Weapon Data" });
    expect(hydrated.edges.map((edge) => edge.id)).toEqual(["compatible", "found"]);
    const materialized = materializeLogicGraph(graph, "graph", "event", options);
    expect(materialized.nodes[0]?.pins.find((pin) => pin.id === "value")?.type).toEqual({ kind: "structRef", guid: "weapon" });
  });

  it("reports missing schemas and incompatible or deleted literal assets inside function graphs", () => {
    const graph: SerializedGraph = {
      nodes: [node("untyped", "data.readRow"), node("unknown", "data.readRow", { definitionGuid: "removed" })],
      edges: [],
      functionGraphs: {
        lookup: { nodes: [
          node("mismatch", "data.readRow", { definitionGuid: "weapon", "default:sheet": "helmet" }),
          node("missing", "data.getSheetRows", { "default:sheet": "deleted" }),
        ], edges: [] },
      },
    };
    const diagnostics = validateSerializedGraph(graph, options).filter((entry) => entry.code.startsWith("data."));
    expect(diagnostics.map((entry) => [entry.nodeId, entry.code])).toEqual([
      ["untyped", "data.missing_definition"], ["unknown", "data.unknown_definition"],
      ["mismatch", "data.definition_mismatch"], ["missing", "data.missing_asset"],
    ]);
    expect(diagnostics.find((entry) => entry.nodeId === "mismatch")).toMatchObject({ graphId: "lookup", pinId: "sheet" });
  });

  it("ignores stale literal defaults when a reference pin is connected", () => {
    const graph: SerializedGraph = {
      nodes: [
        node("source", "variables.get", { name: "Weapon", typeId: "asset", typeClassId: "DataSheet" }),
        node("read", "data.readRow", { definitionGuid: "weapon", "default:sheet": "deleted" }),
      ],
      edges: [{ id: "input", source: "source", sourceHandle: "value", target: "read", targetHandle: "sheet" }],
    };
    expect(validateSerializedGraph(graph, options).filter((entry) => entry.code.startsWith("data."))).toEqual([]);
    graph.nodes[1]!.data.definitionGuid = "";
    expect(hydrateSerializedGraphForEditor(graph, undefined, options).nodes[1]?.data.definitionGuid).toBe("");
  });

  it("captures nested typed defaults for dependency traversal and preserves authored snapshots", () => {
    const structs: TypeSchemas["structs"] = {
      visual: { name: "Visual", fields: [{ id: "mesh", name: "Mesh", typeId: "asset", typeClassId: "Model" }] },
      weapon: { name: "Weapon", fields: [{ id: "visual", name: "Visual", typeId: "struct", typeClassId: "visual" }] },
    };
    const graph = { nodes: [node("create", "editorData.addRow", { definitionGuid: "weapon" })], edges: [] };
    const hydrated = hydrateSerializedGraphForEditor(graph, undefined, { structs, dataDefinitions: structs });
    expect(hydrated.nodes[0]?.data.dataSchema).toEqual([
      { id: "visual", name: "Visual", typeId: "struct", typeClassId: "visual", fields: [
        { id: "mesh", name: "Mesh", typeId: "asset", typeClassId: "Model" },
      ] },
    ]);
    const renamed = { ...structs, weapon: { name: "Weapon", fields: [{ id: "visual", name: "Appearance", typeId: "struct", typeClassId: "visual" }] } };
    expect(hydrateSerializedGraphForEditor(hydrated, undefined, { structs: renamed, dataDefinitions: renamed }).nodes[0]?.data.dataSchema)
      .toEqual(hydrated.nodes[0]?.data.dataSchema);
  });
  it("rejects a plain Structure as the root Data Definition", () => {
    const graph = { nodes: [node("read", "data.readRow", { definitionGuid: "weapon" })], edges: [] };
    expect(validateSerializedGraph(graph, { ...options, dataDefinitions: {} })).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: "read", code: "data.unknown_definition", severity: "error" }),
    ]));
  });

});
