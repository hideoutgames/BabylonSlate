import { describe, expect, it } from "vitest";
import { BOOL, compileGraph, createUnavailableEditorDataApi, EXEC, pin, STRING, structRef, type GraphNode, type LogicGraph } from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "./index";

function graph() {
  const registry = createDefaultNodeRegistry();
  registry.register({
    id: "test.capture", title: "Capture", category: "test",
    pins: () => [pin("execIn", "Exec", "in", EXEC), pin("success", "Success", "in", BOOL), pin("error", "Error", "in", STRING), pin("values", "Values", "in", structRef("item"))],
    codegen: (ctx) => { ctx.emit(`ctx.capture(${ctx.input("success")}, ${ctx.input("error")}, ${ctx.input("values")});`); },
  });
  const node = (id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode => ({
    id, typeId, properties, pins: registry.get(typeId)!.pins(properties), position: { x: 0, y: 0 },
  });
  const edge = (sourceNodeId: string, sourcePinId: string, targetNodeId: string, targetPinId: string) => ({
    id: `${sourceNodeId}-${sourcePinId}-${targetPinId}`, sourceNodeId, sourcePinId, targetNodeId, targetPinId,
  });
  const source: LogicGraph = { id: "utility", kind: "event", nodes: [
    node("start", "flow.event.editorStartup"),
    node("read", "editorData.readObject", { structGuid: "item", "default:object": "sword" }),
    node("capture", "test.capture"),
  ], edges: [edge("start", "execOut", "read", "execIn"), edge("read", "execOut", "capture", "execIn"),
    edge("read", "success", "capture", "success"), edge("read", "error", "capture", "error"), edge("read", "value", "capture", "values")] };
  const compiled = compileGraph(source, { assetGuid: "tools", registry });
  const js = compiled.source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
  return new Function(`${js}\nreturn onEditorStartup;`)() as (ctx: Record<string, unknown>) => Promise<void>;
}

describe("Editor data nodes", () => {
  it("awaits authoring reads and passes the selected asset, Structure and typed value through execution", async () => {
    const calls: unknown[] = [];
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => { finish = resolve; });
    const execute = graph();
    const run = execute({
      editorData: { readObject: (reference: string, structure: string) => { calls.push([reference, structure]); return pending; } },
      capture: (...values: unknown[]) => { calls.push(values); },
    });
    expect(calls).toEqual([["sword", "item"]]);
    finish({ success: true, value: { Price: 18 }, error: "" });
    await run;
    expect(calls).toEqual([["sword", "item"], [true, "", { Price: 18 }]]);
  });

  it("reports an explicit failure when editor capabilities are absent instead of providing authoring access", async () => {
    const calls: unknown[][] = [];
    await graph()({ editorData: createUnavailableEditorDataApi(), capture: (...values: unknown[]) => { calls.push(values); } });
    expect(calls).toEqual([[false, expect.stringContaining("Editor Utility Objects"), {}]]);
    expect(await createUnavailableEditorDataApi().createObject("Unexpected", "item", {})).toMatchObject({ success: false, value: null });
  });
});
