import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@babylonslate/core";
import type { TypeSchemas } from "@babylonslate/scripting";
import { compileGraphDocument } from "./script-compiler";
import { hydrateSerializedGraphForEditor, validateSerializedGraph } from "./graph-validation";

const node = (id: string, type: string, data: Record<string, unknown> = {}): SerializedGraph["nodes"][number] => ({ id, type, position: { x: 0, y: 0 }, data });
const structs: TypeSchemas["structs"] = {
  stats: { name: "Stats", fields: [{ id: "health", name: "HitPoints", typeId: "float", defaultValue: 0 }] },
};

function createGraph(type = "editorData.addRow"): SerializedGraph {
  return {
    nodes: [node("entry", "flow.event.editorStartup"), node("write", type, {
      definitionGuid: "stats", "default:name": "Warrior", "default:sheet": "warriors", "default:rowId": "warrior",
      "default:values": { Health: 10, RemovedIcon: "icon" },
      dataSchema: [
        { id: "health", name: "Health", typeId: "float" },
        { id: "old-icon", name: "RemovedIcon", typeId: "asset", typeClassId: "Texture" },
      ],
    })],
    edges: [{ id: "exec", source: "entry", sourceHandle: "execOut", target: "write", targetHandle: "execIn" }],
  };
}

describe("Compiled data literal schema changes", () => {
  it.each(["editorData.addRow", "editorData.updateRow"])("%s retains authored values after a stable field rename", async (type) => {
    const graph = createGraph(type);
    const compiled = compileGraphDocument(graph, { path: "assets/Build.class.babasset", parentClassId: "EditorUtilityObject", instrumentInfiniteLoops: false, structs, dataDefinitions: structs });
    expect(compiled).not.toBeNull();
    const js = compiled!.source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
    const execute = new Function(`${js}\nreturn onEditorStartup;`)() as (ctx: Record<string, unknown>) => Promise<void>;
    const values: unknown[] = [];
    const write = (definition: string, value: unknown) => {
      values.push([definition, value]);
      return { success: true, value: "warrior", error: "" };
    };
    await execute({ editorData: {
      addRow: async (_sheet: string, definition: string, _name: string, value: unknown) => write(definition, value),
      updateRow: async (_sheet: string, _rowId: string, definition: string, value: unknown) => write(definition, value),
    } });
    expect(values).toEqual([["stats", { HitPoints: 10, RemovedIcon: "icon" }]]);
    expect(graph.nodes[1]?.data["default:values"]).toEqual({ Health: 10, RemovedIcon: "icon" });
    expect(graph.nodes[1]?.data.dataSchema).toEqual([
      { id: "health", name: "Health", typeId: "float" },
      { id: "old-icon", name: "RemovedIcon", typeId: "asset", typeClassId: "Texture" },
    ]);
    const displayed = hydrateSerializedGraphForEditor(graph, undefined, { structs, dataDefinitions: structs });
    expect(displayed.nodes[1]?.data["default:values"]).toEqual({ HitPoints: 10, RemovedIcon: "icon" });
    expect(displayed.nodes[1]?.data.dataSchema).toEqual([
      { id: "health", name: "HitPoints", typeId: "float" },
      { id: "old-icon", name: "RemovedIcon", typeId: "asset", typeClassId: "Texture" },
    ]);
  });

  it("keeps incompatible changes as errors instead of replacing a literal with the new default", () => {
    const graph = createGraph();
    const changed: TypeSchemas["structs"] = { stats: { name: "Stats", fields: [
      { id: "health", name: "HitPoints", typeId: "string", defaultValue: "Default" },
    ] } };
    const hydrated = hydrateSerializedGraphForEditor(graph, undefined, { structs: changed, dataDefinitions: changed });
    expect(hydrated.nodes[1]?.data["default:values"]).toEqual({ HitPoints: 10, RemovedIcon: "icon" });
    expect(graph.nodes[1]?.data["default:values"]).toEqual({ Health: 10, RemovedIcon: "icon" });
    expect(hydrated.nodes[1]?.data.dataSchema).toEqual([
      { id: "health", name: "HitPoints", typeId: "float" },
      { id: "old-icon", name: "RemovedIcon", typeId: "asset", typeClassId: "Texture" },
    ]);
    expect(validateSerializedGraph(graph, { assetGuid: "build", graphId: "graph", structs: changed, dataDefinitions: changed }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: "write", pinId: "values", severity: "error", code: "data.type-mismatch" })]));
  });
  it.each([null, "invalid", []])("reports a malformed literal without breaking graph hydration: %j", (literal) => {
    const graph = createGraph();
    graph.nodes[1]!.data["default:values"] = literal;
    expect(() => hydrateSerializedGraphForEditor(graph, undefined, { structs, dataDefinitions: structs })).not.toThrow();
    expect(validateSerializedGraph(graph, { assetGuid: "build", graphId: "graph", structs, dataDefinitions: structs }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: "write", pinId: "values", severity: "error", code: "data.invalid-values" })]));
  });

});
