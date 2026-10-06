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
    node("read", "editorData.readRow", { definitionGuid: "item", "default:sheet": "shop", "default:rowId": "sword" }),
    node("capture", "test.capture"),
  ], edges: [edge("start", "execOut", "read", "execIn"), edge("read", "execOut", "capture", "execIn"),
    edge("read", "success", "capture", "success"), edge("read", "error", "capture", "error"), edge("read", "value", "capture", "values")] };
  const compiled = compileGraph(source, { assetGuid: "tools", registry });
  const js = compiled.source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
  return new Function(`${js}\nreturn onEditorStartup;`)() as (ctx: Record<string, unknown>) => Promise<void>;
}

describe("Editor data nodes", () => {
  it("awaits authoring reads and passes the selected sheet, row, Data Definition and typed value through execution", async () => {
    const calls: unknown[] = [];
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => { finish = resolve; });
    const execute = graph();
    const run = execute({
      editorData: { readRow: (sheet: string, rowId: string, definition: string) => { calls.push([sheet, rowId, definition]); return pending; } },
      capture: (...values: unknown[]) => { calls.push(values); },
    });
    expect(calls).toEqual([["shop", "sword", "item"]]);
    finish({ success: true, value: { Price: 18 }, error: "" });
    await run;
    expect(calls).toEqual([["shop", "sword", "item"], [true, "", { Price: 18 }]]);
  });

  it("reports an explicit failure when editor capabilities are absent instead of providing authoring access", async () => {
    const calls: unknown[][] = [];
    await graph()({ editorData: createUnavailableEditorDataApi(), capture: (...values: unknown[]) => { calls.push(values); } });
    expect(calls).toEqual([[false, expect.stringContaining("Editor Utility Objects"), {}]]);
    expect(await createUnavailableEditorDataApi().createSheet("Unexpected", "item")).toMatchObject({ success: false, value: null });
  });

  it("passes generated sheet and row identities through an awaited authoring sequence", async () => {
    const registry = createDefaultNodeRegistry();
    const node = (id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode => ({
      id, typeId, properties, pins: registry.get(typeId)!.pins(properties), position: { x: 0, y: 0 },
    });
    const ids = ["start", "create", "add", "update", "reorder", "remove"];
    const edge = (sourceNodeId: string, sourcePinId: string, targetNodeId: string, targetPinId: string) => ({
      id: `${sourceNodeId}-${sourcePinId}-${targetNodeId}-${targetPinId}`, sourceNodeId, sourcePinId, targetNodeId, targetPinId,
    });
    const source: LogicGraph = { id: "authoring", kind: "event", nodes: [
      node("start", "flow.event.editorStartup"),
      node("create", "editorData.createSheet", { definitionGuid: "item", "default:name": "Shop", "default:folder": "Tools" }),
      node("add", "editorData.addRow", { definitionGuid: "item", "default:name": "Sword", "default:values": { Price: 8 } }),
      node("update", "editorData.updateRow", { definitionGuid: "item", "default:values": { Price: 9 } }),
      node("reorder", "editorData.reorderRows", { definitionGuid: "item", "default:rowIds": ["new-row"] }),
      node("remove", "editorData.removeRow", { definitionGuid: "item" }),
    ], edges: [
      ...ids.slice(1).map((id, index) => edge(ids[index]!, "execOut", id, "execIn")),
      ...["add", "update", "reorder", "remove"].map((id) => edge("create", "value", id, "sheet")),
      edge("add", "value", "update", "rowId"), edge("add", "value", "remove", "rowId"),
    ] };
    const compiled = compileGraph(source, { assetGuid: "tools", registry });
    const js = compiled.source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
    const execute = new Function(`${js}\nreturn onEditorStartup;`)() as (ctx: Record<string, unknown>) => Promise<void>;
    const calls: unknown[][] = [];
    const result = (method: string, value: string) => async (...args: unknown[]) => {
      calls.push([method, ...args]);
      return { success: true, value, error: "" };
    };
    await execute({ editorData: {
      createSheet: result("create", "new-sheet"), addRow: result("add", "new-row"),
      updateRow: result("update", "new-row"), reorderRows: result("reorder", "new-sheet"),
      removeRow: result("remove", "new-row"),
    } });
    expect(calls).toEqual([
      ["create", "Shop", "item", "Tools"],
      ["add", "new-sheet", "item", "Sword", { Price: 8 }],
      ["update", "new-sheet", "new-row", "item", { Price: 9 }],
      ["reorder", "new-sheet", "item", ["new-row"]],
      ["remove", "new-sheet", "new-row", "item"],
    ]);
  });
});
