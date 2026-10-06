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
    node("read", "editorData.readEntry", { definitionGuid: "item", "default:tree": "shop", "default:entryPath": "Sword" }),
    node("capture", "test.capture"),
  ], edges: [edge("start", "execOut", "read", "execIn"), edge("read", "execOut", "capture", "execIn"),
    edge("read", "success", "capture", "success"), edge("read", "error", "capture", "error"), edge("read", "value", "capture", "values")] };
  const compiled = compileGraph(source, { assetGuid: "tools", registry });
  const js = compiled.source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
  return new Function(`${js}\nreturn onEditorStartup;`)() as (ctx: Record<string, unknown>) => Promise<void>;
}

describe("Editor data nodes", () => {
  it("awaits authoring reads and passes the selected tree, entry path, Data Definition and typed value through execution", async () => {
    const calls: unknown[] = [];
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => { finish = resolve; });
    const execute = graph();
    const run = execute({
      editorData: { readEntry: (tree: string, entryPath: string, definition: string) => { calls.push([tree, entryPath, definition]); return pending; } },
      capture: (...values: unknown[]) => { calls.push(values); },
    });
    expect(calls).toEqual([["shop", "Sword", "item"]]);
    finish({ success: true, value: { Price: 18 }, error: "" });
    await run;
    expect(calls).toEqual([["shop", "Sword", "item"], [true, "", { Price: 18 }]]);
  });

  it("reports an explicit failure when editor capabilities are absent instead of providing authoring access", async () => {
    const calls: unknown[][] = [];
    await graph()({ editorData: createUnavailableEditorDataApi(), capture: (...values: unknown[]) => { calls.push(values); } });
    expect(calls).toEqual([[false, expect.stringContaining("Editor Utility Objects"), {}]]);
    expect(await createUnavailableEditorDataApi().createTree("Unexpected", "item")).toMatchObject({ success: false, value: null });
  });

  it("passes generated tree references and entry paths through an awaited authoring sequence", async () => {
    const registry = createDefaultNodeRegistry();
    const node = (id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode => ({
      id, typeId, properties, pins: registry.get(typeId)!.pins(properties), position: { x: 0, y: 0 },
    });
    const ids = ["start", "create", "add", "update", "reorder", "move", "remove"];
    const edge = (sourceNodeId: string, sourcePinId: string, targetNodeId: string, targetPinId: string) => ({
      id: `${sourceNodeId}-${sourcePinId}-${targetNodeId}-${targetPinId}`, sourceNodeId, sourcePinId, targetNodeId, targetPinId,
    });
    const source: LogicGraph = { id: "authoring", kind: "event", nodes: [
      node("start", "flow.event.editorStartup"),
      node("create", "editorData.createTree", { definitionGuid: "item", "default:name": "Shop", "default:folder": "Tools" }),
      node("add", "editorData.addEntry", { definitionGuid: "item", "default:parentPath": "Weapons", "default:name": "Sword", "default:values": { Price: 8 } }),
      node("update", "editorData.updateEntry", { definitionGuid: "item", "default:values": { Price: 9 } }),
      node("reorder", "editorData.reorderChildren", { "default:parentPath": "Weapons", "default:entryPaths": ["Weapons/Sword"] }),
      node("move", "editorData.moveEntry", { "default:newParentPath": "Loot" }),
      node("remove", "editorData.removeEntry", { definitionGuid: "item" }),
    ], edges: [
      ...ids.slice(1).map((id, index) => edge(ids[index]!, "execOut", id, "execIn")),
      ...["add", "update", "reorder", "move", "remove"].map((id) => edge("create", "value", id, "tree")),
      edge("add", "value", "update", "entryPath"), edge("add", "value", "move", "entryPath"), edge("move", "value", "remove", "entryPath"),
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
      createTree: result("create", "new-tree"), addEntry: result("add", "Weapons/Sword"),
      updateEntry: result("update", "Weapons/Sword"), reorderChildren: result("reorder", "new-tree"),
      moveEntry: result("move", "Loot/Sword"), removeEntry: result("remove", "Loot/Sword"),
    } });
    expect(calls).toEqual([
      ["create", "Shop", "item", "Tools"],
      ["add", "new-tree", "Weapons", "Sword", "item", { Price: 8 }],
      ["update", "new-tree", "Weapons/Sword", "item", { Price: 9 }],
      ["reorder", "new-tree", "Weapons", ["Weapons/Sword"]],
      ["move", "new-tree", "Weapons/Sword", "Loot", undefined],
      ["remove", "new-tree", "Loot/Sword"],
    ]);
  });

  it.each([
    ["inherit", "item", undefined, { Price: 3 }],
    ["none", "item", null, undefined],
    ["override", "item", "item", { Price: 3 }],
    [undefined, undefined, undefined, undefined],
  ])("passes the %s Definition choice without inventing inherited values", async (mode, definition, expectedDefinition, expectedValues) => {
    const registry = createDefaultNodeRegistry();
    const properties = { definitionMode: mode, definitionGuid: definition, "default:tree": "catalog", "default:parentPath": "Weapons", "default:name": "Sword", "default:values": { Price: 3 } };
    const graph: LogicGraph = { id: "mode", kind: "event", nodes: [
      { id: "start", typeId: "flow.event.editorStartup", properties: {}, pins: registry.get("flow.event.editorStartup")!.pins({}), position: { x: 0, y: 0 } },
      { id: "add", typeId: "editorData.addEntry", properties, pins: registry.get("editorData.addEntry")!.pins(properties), position: { x: 1, y: 1 } },
    ], edges: [{ id: "exec", sourceNodeId: "start", sourcePinId: "execOut", targetNodeId: "add", targetPinId: "execIn" }] };
    const compiled = compileGraph(graph, { assetGuid: "tools", registry });
    const js = compiled.source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
    const execute = new Function(`${js}\nreturn onEditorStartup;`)() as (ctx: Record<string, unknown>) => Promise<void>;
    const calls: unknown[][] = [];
    await execute({ editorData: { addEntry: async (...args: unknown[]) => {
      calls.push(args); return { success: true, value: "Weapons/Sword", error: "" };
    } } });
    expect(calls).toEqual([["catalog", "Weapons", "Sword", expectedDefinition, expectedValues]]);
  });

});
