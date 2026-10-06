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
    fireEvent.change(screen.getByRole("textbox", { name: "Values Prices Item 1", exact: true }), { target: { value: "2.5" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Values Lookup Key 1 Code", exact: true }), { target: { value: "rare" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Values Lookup Value 1 Weight", exact: true }), { target: { value: "9" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Values Lookup Value 1 Samples Item 2", exact: true }), { target: { value: "12" } });

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
});
