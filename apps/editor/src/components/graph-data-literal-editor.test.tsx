import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SerializedGraph } from "@babylonslate/core";
import { mergeEngineTypeSchemas, type TypeSchemas } from "@babylonslate/scripting";
import { patchDataGraphNode } from "../lib/data-graph";
import { graphDataLiteralField, inspectorLiteralPinDefaults } from "../lib/graph-inspector";
import type { useDataCatalog } from "../lib/use-data-catalog";
import { compileGraphDocument } from "../services/script-compiler";
import { hydrateSerializedGraphForEditor, validateSerializedGraph } from "../services/graph-validation";
import { GraphDataLiteralEditor } from "./graph-data-literal-editor";

const definitions: NonNullable<TypeSchemas["dataDefinitions"]> = {
  inventory: { name: "Inventory", fields: [
    { id: "prices", name: "Prices", typeId: "float", container: "array" },
    { id: "lookup", name: "Lookup", typeId: "struct", typeClassId: "details", container: "map", keyTypeId: "struct", keyTypeClassId: "key" },
    { id: "note", name: "Note", typeId: "string", defaultValue: "New Default" },
  ] },
  key: { name: "Key", fields: [{ id: "code", name: "Code", typeId: "string" }] },
  details: { name: "Details", fields: [
    { id: "weight", name: "Weight", typeId: "float" },
    { id: "samples", name: "Samples", typeId: "float", container: "array" },
  ] },
};
const schemas = mergeEngineTypeSchemas({ dataDefinitions: definitions });
const catalog: ReturnType<typeof useDataCatalog> = {
  assets: [], byGuid: new Map(), schemas, enumMembers: {}, pickerAssets: [], propertyAssets: [], classEntries: [],
  types: { structures: [], enums: [], dataDefinitions: Object.entries(definitions).map(([guid, schema]) => ({ guid, ...schema })) },
};
const node = (id: string, type: string, data: Record<string, unknown> = {}): SerializedGraph["nodes"][number] => ({ id, type, position: { x: 0, y: 0 }, data });

function createGraph(type: string): SerializedGraph {
  return {
    nodes: [node("entry", "flow.event.editorStartup"), node("write", type, {
      definitionGuid: "inventory", "default:sheet": "shop", "default:rowId": "sword", "default:name": "Sword",
      "default:values": { Prices: [2, 4], Lookup: [{ key: { Code: "common" }, value: { Weight: 3, Samples: [6, 8] } }], Note: "Authored" },
    })],
    edges: [{ id: "exec", source: "entry", sourceHandle: "execOut", target: "write", targetHandle: "execIn" }],
  };
}

afterEach(cleanup);

describe("Definition collection literals in the graph Inspector", () => {
  it.each(["editorData.addRow", "editorData.updateRow"])("edits typed collections and preserves their shape through %s execution", async (type) => {
    let authored = createGraph(type);
    function Inspector() {
      const [graph, setGraph] = useState(authored);
      const displayed = hydrateSerializedGraphForEditor(graph, undefined, schemas);
      const selected = displayed.nodes.find((entry) => entry.id === "write")!;
      const literal = inspectorLiteralPinDefaults(selected, graph.edges, displayed.nodes)
        .find((entry) => entry.pinId === "values" && graphDataLiteralField(entry, schemas));
      if (!literal) throw new Error("The Definition value must route to the typed Inspector editor.");
      return <GraphDataLiteralEditor entry={literal} catalog={catalog} onChange={(value) => {
        authored = patchDataGraphNode(graph, selected, { "default:values": value });
        setGraph(authored);
      }} />;
    }
    render(<Inspector />);
    fireEvent.change(screen.getByRole("textbox", { name: "Values Prices Item 1" }), { target: { value: "2.5" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Values Lookup Key 1 Code" }), { target: { value: "rare" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Values Lookup Value 1 Weight" }), { target: { value: "9" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Values Lookup Value 1 Samples Item 2" }), { target: { value: "12" } });

    const expected = { Prices: [2.5, 4], Lookup: [{ key: { Code: "rare" }, value: { Weight: 9, Samples: [6, 12] } }], Note: "Authored" };
    expect(authored.nodes[1]!.data["default:values"]).toEqual(expected);
    expect(authored.nodes[1]!.data.dataSchema).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Prices", container: "array", typeId: "float" }),
      expect.objectContaining({ name: "Lookup", container: "map", keyTypeId: "struct", keyTypeClassId: "key", keyFields: [expect.objectContaining({ name: "Code", typeId: "string" })] }),
    ]));
    expect(validateSerializedGraph(authored, { assetGuid: "tools", graphId: "graph", classId: "EditorUtilityObject", ...schemas })
      .filter((issue) => issue.severity === "error")).toEqual([]);
    const compiled = compileGraphDocument(authored, { path: "assets/Tools.class.babasset", parentClassId: "EditorUtilityObject", instrumentInfiniteLoops: false, ...schemas });
    expect(compiled).not.toBeNull();
    const js = compiled!.source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
    const execute = new Function(`${js}\nreturn onEditorStartup;`)() as (ctx: Record<string, unknown>) => Promise<void>;
    const calls: unknown[][] = [];
    await execute({ editorData: {
      addRow: async (...args: unknown[]) => { calls.push(args); return { success: true, value: "sword", error: "" }; },
      updateRow: async (...args: unknown[]) => { calls.push(args); return { success: true, value: "sword", error: "" }; },
    } });
    // Utility authoring accepts portable map entries as well as native Maps.
    expect(calls).toEqual(type === "editorData.addRow"
      ? [["shop", "inventory", "Sword", expected]]
      : [["shop", "sword", "inventory", expected]]);
  });

  it.each(["Cost", "Quantity"])("repairs a rename and an added field when %s is edited first", async (first) => {
    const changedDefinitions = { ...definitions, inventory: { name: "Inventory", fields: [
      { id: "price", name: "Cost", typeId: "float", defaultValue: 99 },
      { id: "quantity", name: "Quantity", typeId: "float", defaultValue: 7 },
    ] } };
    const changedSchemas = mergeEngineTypeSchemas({ dataDefinitions: changedDefinitions });
    const changedCatalog = { ...catalog, schemas: changedSchemas,
      types: { ...catalog.types, dataDefinitions: Object.entries(changedDefinitions).map(([guid, schema]) => ({ guid, ...schema })) },
    };
    let authored = createGraph("editorData.addRow");
    authored.nodes[1]!.data["default:values"] = { Price: 5, RemovedIcon: "icon" };
    authored.nodes[1]!.data.dataSchema = [
      { id: "price", name: "Price", typeId: "float" },
      { id: "removed", name: "RemovedIcon", typeId: "asset", typeClassId: "Texture" },
    ];
    const projected = hydrateSerializedGraphForEditor(authored, undefined, changedSchemas);
    expect(projected.nodes[1]!.data["default:values"]).toEqual({ Cost: 5, RemovedIcon: "icon" });
    expect(authored.nodes[1]!.data["default:values"]).toEqual({ Price: 5, RemovedIcon: "icon" });
    expect(validateSerializedGraph(authored, { assetGuid: "tools", graphId: "graph", classId: "EditorUtilityObject", ...changedSchemas })
      .filter((issue) => issue.severity === "error")).toEqual([
      expect.objectContaining({ code: "data.missing-field", message: expect.stringContaining("Quantity") }),
    ]);

    function Inspector() {
      const [graph, setGraph] = useState(authored);
      const displayed = hydrateSerializedGraphForEditor(graph, undefined, changedSchemas);
      const selected = displayed.nodes.find((entry) => entry.id === "write")!;
      const literal = inspectorLiteralPinDefaults(selected, graph.edges, displayed.nodes).find((entry) => entry.pinId === "values")!;
      return <GraphDataLiteralEditor entry={literal} catalog={changedCatalog} onChange={(value) => {
        authored = patchDataGraphNode(graph, selected, { "default:values": value });
        setGraph(authored);
      }} />;
    }
    render(<Inspector />);
    expect((screen.getByRole("textbox", { name: "Values Cost" }) as HTMLInputElement).value).toBe("5");
    const edit = (name: string) => fireEvent.change(screen.getByRole("textbox", { name: `Values ${name}` }), {
      target: { value: name === "Cost" ? "10" : "2" },
    });
    edit(first);
    expect(authored.nodes[1]!.data["default:values"]).toEqual(first === "Cost"
      ? { Cost: 10, RemovedIcon: "icon" }
      : { Cost: 5, Quantity: 2, RemovedIcon: "icon" });
    edit(first === "Cost" ? "Quantity" : "Cost");
    expect(validateSerializedGraph(authored, { assetGuid: "tools", graphId: "graph", classId: "EditorUtilityObject", ...changedSchemas })
      .filter((issue) => issue.severity === "error")).toEqual([]);
    expect(authored.nodes[1]!.data.dataSchema).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "price", name: "Cost" }),
      expect.objectContaining({ id: "removed", name: "RemovedIcon", typeId: "asset" }),
    ]));
    const compiled = compileGraphDocument(authored, { path: "assets/Tools.class.babasset", parentClassId: "EditorUtilityObject", instrumentInfiniteLoops: false, ...changedSchemas });
    expect(compiled).not.toBeNull();
    const js = compiled!.source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
    const execute = new Function(`${js}\nreturn onEditorStartup;`)() as (ctx: Record<string, unknown>) => Promise<void>;
    const calls: unknown[][] = [];
    await execute({ editorData: { addRow: async (...args: unknown[]) => {
      calls.push(args); return { success: true, value: "sword", error: "" };
    } } });
    expect(calls).toEqual([["shop", "inventory", "Sword", { Cost: 10, Quantity: 2, RemovedIcon: "icon" }]]);
  });
});
