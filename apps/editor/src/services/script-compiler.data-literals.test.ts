import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@babylonslate/core";
import type { TypeSchemas } from "@babylonslate/scripting";
import { compileGraphDocument } from "./script-compiler";
import { hydrateSerializedGraphForEditor, validateSerializedGraph } from "./graph-validation";

const node = (id: string, type: string, data: Record<string, unknown> = {}): SerializedGraph["nodes"][number] => ({ id, type, position: { x: 0, y: 0 }, data });
const structs: TypeSchemas["structs"] = {
  stats: { name: "Stats", fields: [{ id: "health", name: "HitPoints", typeId: "float", defaultValue: 0 }] },
};

function createGraph(type = "editorData.createObject"): SerializedGraph {
  return {
    nodes: [node("entry", "flow.event.editorStartup"), node("write", type, {
      structGuid: "stats", "default:name": "Warrior", "default:object": "warrior",
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
  it.each(["editorData.createObject", "editorData.updateObject"])("%s retains authored values after a stable field rename", async (type) => {
    const graph = createGraph(type);
    const compiled = compileGraphDocument(graph, { path: "assets/Build.class.babasset", parentClassId: "EditorUtilityObject", instrumentInfiniteLoops: false, structs });
    expect(compiled).not.toBeNull();
    const js = compiled!.source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
    const execute = new Function(`${js}\nreturn onEditorStartup;`)() as (ctx: Record<string, unknown>) => Promise<void>;
    const values: unknown[] = [];
    const write = async (_identity: string, structure: string, value: unknown) => {
      values.push([structure, value]);
      return { success: true, value: "warrior", error: "" };
    };
    await execute({ editorData: { createObject: write, updateObject: write } });
    expect(values).toEqual([["stats", { HitPoints: 10, RemovedIcon: "icon" }]]);
    expect(graph.nodes[1]?.data["default:values"]).toEqual({ Health: 10, RemovedIcon: "icon" });
    expect(graph.nodes[1]?.data.dataSchema).toEqual([
      { id: "health", name: "Health", typeId: "float" },
      { id: "old-icon", name: "RemovedIcon", typeId: "asset", typeClassId: "Texture" },
    ]);
    const displayed = hydrateSerializedGraphForEditor(graph, undefined, { structs });
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
    const hydrated = hydrateSerializedGraphForEditor(graph, undefined, { structs: changed });
    expect(hydrated.nodes[1]?.data["default:values"]).toEqual({ Health: 10, RemovedIcon: "icon" });
    expect(validateSerializedGraph(graph, { assetGuid: "build", graphId: "graph", structs: changed }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: "write", pinId: "values", severity: "error", code: "data.type-mismatch" })]));
  });
});
