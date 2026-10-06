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
  { guid: "sword", name: "Sword", type: "DataTree", entries: [{ id: "sword", path: "Weapons/Sword", parentPath: "Weapons", effectiveDefinitionGuid: "weapon" }] },
  { guid: "helmet", name: "Helmet", type: "DataTree", entries: [{ id: "helmet", path: "Armor/Helmet", parentPath: "Armor", effectiveDefinitionGuid: "armor" }] },
  { guid: "weapons", name: "Weapons", type: "DataTree", entries: [{ id: "sword", path: "Weapons/Sword", parentPath: "Weapons", effectiveDefinitionGuid: "weapon" }] },
];
const node = (id: string, type: string, data: Record<string, unknown> = {}): SerializedGraph["nodes"][number] => ({ id, type, position: { x: 0, y: 0 }, data });
const options = { assetGuid: "class", graphId: "graph", structs: structures, dataDefinitions: structures, dataAssets };

describe("Data graph integration", () => {
  it("offers typed read nodes and keeps editor writes on editor utility hosts", () => {
    const registry = createDefaultNodeRegistry();
    const catalog = { dataDefinitions: [{ guid: "weapon", ...structures.weapon! }] };
    const game = scriptPaletteNodes(registry, { ...catalog, parentClass: "Actor" });
    const read = game.find((entry) => entry.id === "data.readEntry:weapon");
    expect(read?.title).toBe("Read Weapon Data");
    expect(read?.pins?.find((pin) => pin.id === "value")?.type).toEqual({ kind: "structRef", guid: "weapon" });
    expect(game.find((entry) => entry.id === "struct.break:weapon")?.title).toBe("Break Weapon Data");
    expect(game.some((entry) => entry.id.startsWith("editorData."))).toBe(false);
    const editor = scriptPaletteNodes(registry, { ...catalog, parentClass: "EditorUtilityObject" });
    expect(editor.find((entry) => entry.id === "editorData.updateEntry:weapon")?.pins?.find((pin) => pin.id === "values")?.type)
      .toEqual({ kind: "structRef", guid: "weapon" });
  });

  it("offers pure typed Definition nodes in transition rules without editor actions", () => {
    const rules = scriptPaletteNodes(createDefaultNodeRegistry(), {
      parentClass: "BObject", animationGraphHost: "rule",
      dataDefinitions: [{ guid: "weapon", ...structures.weapon! }],
      enums: [{ guid: "quality", name: "Quality", members: [{ name: "Common", value: 0 }] }],
    });
    expect(rules.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      "data.readEntry:weapon", "data.getDescendants", "struct.make:weapon", "struct.break:weapon", "enum.equals:quality",
    ]));
    expect(rules.every((entry) => entry.pure === true)).toBe(true);
    expect(rules.some((entry) => entry.id.startsWith("editorData."))).toBe(false);
    expect(rules.some((entry) => entry.id === "enum.switch:quality")).toBe(false);
  });

  it("infers an unwired literal's Data Definition and refreshes stale pins without losing compatible wires", () => {
    const graph: SerializedGraph = {
      nodes: [
        node("read", "data.readEntry", { "default:tree": "sword", "default:entryPath": "Weapons/Sword", __pins: [{ id: "value", direction: "out", kind: "data", type: { kind: "structRef", guid: "armor" } }] }),
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
      nodes: [node("untyped", "data.readEntry"), node("unknown", "data.readEntry", { definitionGuid: "removed" })],
      edges: [],
      functionGraphs: {
        lookup: { nodes: [
          node("mismatch", "data.readEntry", { definitionGuid: "weapon", "default:tree": "helmet", "default:entryPath": "Armor/Helmet" }),
          node("missing", "data.getDescendants", { "default:tree": "deleted" }),
        ], edges: [] },
      },
    };
    const diagnostics = validateSerializedGraph(graph, options).filter((entry) => entry.code.startsWith("data."));
    expect(diagnostics.map((entry) => [entry.nodeId, entry.code])).toEqual([
      ["untyped", "data.missing_definition"], ["unknown", "data.unknown_definition"],
      ["mismatch", "data.definition_mismatch"], ["missing", "data.missing_asset"],
    ]);
    expect(diagnostics.find((entry) => entry.nodeId === "mismatch")).toMatchObject({ graphId: "lookup", pinId: "entryPath" });
  });

  it("ignores stale literal defaults when a reference pin is connected", () => {
    const graph: SerializedGraph = {
      nodes: [
        node("source", "variables.get", { name: "Weapon", typeId: "asset", typeClassId: "DataTree" }),
        node("read", "data.readEntry", { definitionGuid: "weapon", "default:tree": "deleted" }),
      ],
      edges: [{ id: "input", source: "source", sourceHandle: "value", target: "read", targetHandle: "tree" }],
    };
    expect(validateSerializedGraph(graph, options).filter((entry) => entry.code.startsWith("data."))).toEqual([]);
    graph.nodes[1]!.data.definitionGuid = "";
    expect(hydrateSerializedGraphForEditor(graph, undefined, options).nodes[1]?.data.definitionGuid).toBe("");
  });

  it("warns on unresolved literal entry paths without retargeting them after a rename", () => {
    const graph: SerializedGraph = {
      nodes: [node("read", "data.readEntry", { definitionGuid: "weapon", "default:tree": "sword", "default:entryPath": "Sword" })],
      edges: [],
    };
    const catalog = [{ ...dataAssets[0]!, entries: [{ id: "stable-entry", path: "Longsword", parentPath: "", effectiveDefinitionGuid: "weapon" }] }];
    const currentOptions = { ...options, dataAssets: catalog };
    expect(hydrateSerializedGraphForEditor(graph, undefined, currentOptions).nodes[0]?.data["default:entryPath"]).toBe("Sword");
    expect(validateSerializedGraph(graph, currentOptions).filter((entry) => entry.code === "data.missing_entry"))
      .toEqual([expect.objectContaining({ nodeId: "read", pinId: "entryPath", severity: "warning" })]);
    graph.nodes[0]!.data["default:entryPath"] = "Longsword";
    expect(validateSerializedGraph(graph, currentOptions).some((entry) => entry.code === "data.missing_entry")).toBe(false);
    graph.nodes[0]!.data["default:entryPath"] = "longsword";
    expect(validateSerializedGraph(graph, currentOptions).some((entry) => entry.code === "data.missing_entry")).toBe(true);
    graph.nodes.push(node("sheet", "variables.get", { name: "Sheet", typeId: "asset", typeClassId: "DataTree" }));
    graph.edges.push({ id: "sheet", source: "sheet", sourceHandle: "value", target: "read", targetHandle: "tree" });
    expect(validateSerializedGraph(graph, currentOptions).some((entry) => entry.code === "data.missing_entry")).toBe(false);
  });

  it("keeps an authored read type when an entry's inherited Definition changes and requires dynamic paths to choose a type", () => {
    const graph: SerializedGraph = { nodes: [node("read", "data.readEntry", {
      "default:tree": "sword", "default:entryPath": "Weapons/Sword", definitionGuid: "weapon",
    })], edges: [] };
    const changed = [{ ...dataAssets[0]!, entries: dataAssets[0]!.entries.map((entry) => ({ ...entry, effectiveDefinitionGuid: "armor" })) }];
    const hydrated = hydrateSerializedGraphForEditor(graph, undefined, { ...options, dataAssets: changed });
    expect(hydrated.nodes[0]?.data.definitionGuid).toBe("weapon");
    expect(validateSerializedGraph(graph, { ...options, dataAssets: changed })).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "data.definition_mismatch", pinId: "entryPath" }),
    ]));
    graph.nodes[0]!.data.definitionGuid = "";
    graph.nodes.push(node("path", "variables.get", { name: "Path", typeId: "string" }));
    graph.edges.push({ id: "path", source: "path", sourceHandle: "value", target: "read", targetHandle: "entryPath" });
    expect(validateSerializedGraph(graph, options)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "data.missing_definition", nodeId: "read" }),
    ]));
  });

  it("captures nested typed defaults for dependency traversal and preserves authored snapshots", () => {
    const structs: TypeSchemas["structs"] = {
      visual: { name: "Visual", fields: [{ id: "mesh", name: "Mesh", typeId: "asset", typeClassId: "Model" }] },
      weapon: { name: "Weapon", fields: [{ id: "visual", name: "Visual", typeId: "struct", typeClassId: "visual" }] },
    };
    const graph = { nodes: [node("create", "editorData.addEntry", { definitionGuid: "weapon", "default:values": { Visual: { Mesh: "mesh" } } })], edges: [] };
    const hydrated = hydrateSerializedGraphForEditor(graph, undefined, { structs, dataDefinitions: structs });
    expect(hydrated.nodes[0]?.data.dataSchema).toEqual([
      { id: "visual", name: "Visual", typeId: "struct", typeClassId: "visual", fields: [
        { id: "mesh", name: "Mesh", typeId: "asset", typeClassId: "Model" },
      ] },
    ]);
    const renamed = { ...structs, weapon: { name: "Weapon", fields: [{ id: "visual", name: "Appearance", typeId: "struct", typeClassId: "visual" }] } };
    const updated = hydrateSerializedGraphForEditor(hydrated, undefined, { structs: renamed, dataDefinitions: renamed });
    expect(updated.nodes[0]?.data["default:values"]).toEqual({ Appearance: { Mesh: "mesh" } });
    expect(updated.nodes[0]?.data.dataSchema).toEqual([
      { id: "visual", name: "Appearance", typeId: "struct", typeClassId: "visual", fields: [
        { id: "mesh", name: "Mesh", typeId: "asset", typeClassId: "Model" },
      ] },
    ]);
    expect(hydrated.nodes[0]?.data["default:values"]).toEqual({ Visual: { Mesh: "mesh" } });
    const read = { nodes: [node("read", "data.readEntry", { definitionGuid: "weapon" })], edges: [] };
    expect(hydrateSerializedGraphForEditor(read, undefined, { structs, dataDefinitions: structs }).nodes[0]?.data.dataSchema).toEqual([
      { id: "visual", name: "Visual", typeId: "struct", typeClassId: "visual" },
    ]);
  });
  it("checks inherited typed additions against the parent and tree default and requires Override for dynamic parents", () => {
    const graph: SerializedGraph = { nodes: [node("add", "editorData.addEntry", {
      definitionGuid: "weapon", definitionMode: "inherit", "default:tree": "tree", "default:parentPath": "",
      "default:values": { Damage: 15 },
    })], edges: [] };
    const catalog: DataGraphAssetEntry[] = [{ guid: "tree", name: "Items", type: "DataTree", defaultDefinitionGuid: "weapon", entries: [
      { id: "armor", path: "Armor", parentPath: "", effectiveDefinitionGuid: "armor" },
    ] }];
    const current = { ...options, classId: "EditorUtilityObject", dataAssets: catalog };
    const dataErrors = () => validateSerializedGraph(graph, current).filter((entry) => entry.code.startsWith("data."));
    expect(dataErrors()).toEqual([]);
    graph.nodes[0]!.data["default:parentPath"] = "Armor";
    expect(dataErrors()).toEqual([expect.objectContaining({ code: "data.definition_mismatch", pinId: "parentPath" })]);
    graph.nodes[0]!.data["default:parentPath"] = "";
    graph.nodes.push(node("path", "variables.get", { name: "Path", typeId: "string" }));
    graph.edges.push({ id: "path", source: "path", sourceHandle: "value", target: "add", targetHandle: "parentPath" });
    expect(dataErrors()).toEqual([expect.objectContaining({ code: "data.dynamic_inherited_values", message: expect.stringContaining("Use Override") })]);
    graph.nodes[0]!.data.definitionMode = "override";
    expect(dataErrors()).toEqual([]);
    graph.nodes[0]!.data.definitionMode = "inherit";
    graph.nodes[0]!.data.definitionGuid = "";
    expect(dataErrors()).toEqual([]);
  });
  it("rejects a plain Structure as the root Data Definition", () => {
    const graph = { nodes: [node("read", "data.readEntry", { definitionGuid: "weapon" })], edges: [] };
    expect(validateSerializedGraph(graph, { ...options, dataDefinitions: {} })).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: "read", code: "data.unknown_definition", severity: "error" }),
    ]));
  });

});
