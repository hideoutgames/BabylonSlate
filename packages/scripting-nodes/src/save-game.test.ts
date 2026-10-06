import { describe, expect, it } from "vitest";
import { compileGraph, type GraphNode, type LogicGraph } from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "./index";

const registry = createDefaultNodeRegistry();
function node(id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode {
  return { id, typeId, properties, position: { x: 0, y: 0 }, pins: registry.get(typeId)!.pins(properties) };
}
function edge(sourceNodeId: string, sourcePinId: string, targetNodeId: string, targetPinId: string) {
  return { id: `${sourceNodeId}:${sourcePinId}:${targetNodeId}`, sourceNodeId, sourcePinId, targetNodeId, targetPinId };
}
function compile(nodes: GraphNode[], edges: LogicGraph["edges"]) {
  const graph: LogicGraph = { id: "save", kind: "event", nodes, edges };
  const compiled = compileGraph(graph, { registry, assetGuid: "save-graph" });
  const source = compiled.source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
  return new Function(`${source}\nreturn run;`)() as (ctx: Record<string, unknown>) => Promise<void>;
}

describe("Save Game graph execution", () => {
  it.each(["newGame", "saveGame", "loadGame", "listSaves", "deleteSave"])("%s waits and takes exactly the matching completion branch", async (method) => {
    const run = compile([
      node("entry", "flow.entry"), node("save", `saveGame.${method}`),
      node("success", "debug.executeJavaScript", { body: "ctx.events.push('completed');" }),
      node("failure", "debug.executeJavaScript", { inputs: [{ name: "code", type: { kind: "string" } }], body: "ctx.events.push(code);" }),
    ], [edge("entry", "execOut", "save", "execIn"), edge("save", "completed", "success", "execIn"),
      edge("save", "failed", "failure", "execIn"), edge("save", "errorCode", "failure", "in_code")]);
    for (const result of [{ ok: true, value: [] }, { ok: false, error: { code: "corrupt", message: "Invalid checksum" } }]) {
      const events: string[] = [];
      let complete!: (value: unknown) => void;
      const operation = run({ events, [method]: () => new Promise((resolve) => { complete = resolve; }) });
      expect(events).toEqual([]);
      complete(result);
      await operation;
      expect(events).toEqual([result.ok ? "completed" : "corrupt"]);
    }
  });

  it("passes explicit slots/profiles and leaves default selection to the service", async () => {
    const run = compile([node("entry", "flow.entry"), node("first", "saveGame.saveGame", { slot: "checkpoint", profile: "player-2" }),
      node("default", "saveGame.loadGame")], [edge("entry", "execOut", "first", "execIn"), edge("first", "completed", "default", "execIn")]);
    const saved: unknown[] = [];
    await run({ saveGame: async (options: unknown) => { saved.push(options); return { ok: true, value: {} }; },
      loadGame: async (options: unknown) => { saved.push(options); return { ok: true, value: {} }; } });
    expect(saved).toEqual([{ slot: "checkpoint", profile: "player-2" }, { slot: undefined, profile: undefined }]);
  });

  it("generated field access uses immutable field identity even when an old node still displays its previous name", async () => {
    const fields = new Map<string, unknown>([["coins-id", 17]]);
    const run = compile([node("entry", "flow.entry"), node("get", "saveGame.getField", { fieldId: "coins-id", fieldName: "Old Coins", typeId: "int" }),
      node("set", "saveGame.setField", { fieldId: "score-id", fieldName: "Score", typeId: "int" })],
    [edge("entry", "execOut", "set", "execIn"), edge("get", "value", "set", "value")]);
    await run({ getSaveField: (id: string) => fields.get(id), setSaveField: (id: string, value: unknown) => fields.set(id, value) });
    expect(fields.get("score-id")).toBe(17);
  });
});
