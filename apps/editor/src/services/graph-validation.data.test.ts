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
  { guid: "sword", name: "Sword", type: "DataObject", structureGuid: "weapon" },
  { guid: "helmet", name: "Helmet", type: "DataObject", structureGuid: "armor" },
  { guid: "weapons", name: "Weapons", type: "DataSheet", structureGuid: "weapon" },
];
const node = (id: string, type: string, data: Record<string, unknown> = {}): SerializedGraph["nodes"][number] => ({ id, type, position: { x: 0, y: 0 }, data });
const options = { assetGuid: "class", graphId: "graph", structs: structures, dataAssets };

describe("Data graph integration", () => {
  it("offers typed read nodes and keeps editor writes on editor utility hosts", () => {
    const registry = createDefaultNodeRegistry();
    const catalog = { structures: [{ guid: "weapon", ...structures.weapon! }] };
    const game = scriptPaletteNodes(registry, { ...catalog, parentClass: "Actor" });
    const read = game.find((entry) => entry.id === "data.readObject:weapon");
    expect(read?.title).toBe("Read Weapon Data");
    expect(read?.pins?.find((pin) => pin.id === "value")?.type).toEqual({ kind: "structRef", guid: "weapon" });
    expect(game.some((entry) => entry.id.startsWith("editorData."))).toBe(false);
    const editor = scriptPaletteNodes(registry, { ...catalog, parentClass: "EditorUtilityObject" });
    expect(editor.find((entry) => entry.id === "editorData.updateObject:weapon")?.pins?.find((pin) => pin.id === "values")?.type)
      .toEqual({ kind: "structRef", guid: "weapon" });
  });

  it("infers an unwired literal's Structure and refreshes stale pins without losing compatible wires", () => {
    const graph: SerializedGraph = {
      nodes: [
        node("read", "data.readObject", { "default:object": "sword", __pins: [{ id: "value", direction: "out", kind: "data", type: { kind: "structRef", guid: "armor" } }] }),
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
    expect(hydrated.nodes[0]?.data).toMatchObject({ structGuid: "weapon", title: "Read Weapon Data" });
    expect(hydrated.edges.map((edge) => edge.id)).toEqual(["compatible", "found"]);
    const materialized = materializeLogicGraph(graph, "graph", "event", options);
    expect(materialized.nodes[0]?.pins.find((pin) => pin.id === "value")?.type).toEqual({ kind: "structRef", guid: "weapon" });
  });

  it("reports missing schemas and incompatible or deleted literal assets inside function graphs", () => {
    const graph: SerializedGraph = {
      nodes: [node("untyped", "data.readObject"), node("unknown", "data.readObject", { structGuid: "removed" })],
      edges: [],
      functionGraphs: {
        lookup: { nodes: [
          node("mismatch", "data.readObject", { structGuid: "weapon", "default:object": "helmet" }),
          node("missing", "data.getSheetObjects", { "default:sheet": "deleted" }),
        ], edges: [] },
      },
    };
    const diagnostics = validateSerializedGraph(graph, options).filter((entry) => entry.code.startsWith("data."));
    expect(diagnostics.map((entry) => [entry.nodeId, entry.code])).toEqual([
      ["untyped", "data.missing_structure"], ["unknown", "data.unknown_structure"],
      ["mismatch", "data.structure_mismatch"], ["missing", "data.missing_asset"],
    ]);
    expect(diagnostics.find((entry) => entry.nodeId === "mismatch")).toMatchObject({ graphId: "lookup", pinId: "object" });
  });

  it("ignores stale literal defaults when a reference pin is connected", () => {
    const graph: SerializedGraph = {
      nodes: [
        node("source", "variables.get", { name: "Weapon", typeId: "asset", typeClassId: "DataObject" }),
        node("read", "data.readObject", { structGuid: "weapon", "default:object": "deleted" }),
      ],
      edges: [{ id: "input", source: "source", sourceHandle: "value", target: "read", targetHandle: "object" }],
    };
    expect(validateSerializedGraph(graph, options).filter((entry) => entry.code.startsWith("data."))).toEqual([]);
    graph.nodes[1]!.data.structGuid = "";
    expect(hydrateSerializedGraphForEditor(graph, undefined, options).nodes[1]?.data.structGuid).toBe("");
  });

  it("captures nested typed defaults for dependency traversal and preserves authored snapshots", () => {
    const structs: TypeSchemas["structs"] = {
      visual: { name: "Visual", fields: [{ id: "mesh", name: "Mesh", typeId: "asset", typeClassId: "Model" }] },
      weapon: { name: "Weapon", fields: [{ id: "visual", name: "Visual", typeId: "struct", typeClassId: "visual" }] },
    };
    const graph = { nodes: [node("create", "editorData.createObject", { structGuid: "weapon" })], edges: [] };
    const hydrated = hydrateSerializedGraphForEditor(graph, undefined, { structs });
    expect(hydrated.nodes[0]?.data.dataSchema).toEqual([
      { id: "visual", name: "Visual", typeId: "struct", typeClassId: "visual", fields: [
        { id: "mesh", name: "Mesh", typeId: "asset", typeClassId: "Model" },
      ] },
    ]);
    const renamed = { ...structs, weapon: { name: "Weapon", fields: [{ id: "visual", name: "Appearance", typeId: "struct", typeClassId: "visual" }] } };
    expect(hydrateSerializedGraphForEditor(hydrated, undefined, { structs: renamed }).nodes[0]?.data.dataSchema)
      .toEqual(hydrated.nodes[0]?.data.dataSchema);
  });
});
