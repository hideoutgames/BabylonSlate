import { describe, expect, it } from "vitest";
import { createDataObjectAsset, createDataSheetAsset, type DataAssetCatalogEntry } from "@babylonslate/core";
import { clearDeletedAssetRefs } from "@babylonslate/assets";
import { compileGraph, type GraphNode, type LogicGraph } from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { RuntimeDataCatalog } from "./data-catalog";
import { ScriptHost, type ScriptHostServices } from "./script-host";
import { loadCompiledModule } from "./module-loader";
import { runtimeOptionsFromLoadControl } from "./play-load";
import { createInProcessRuntime } from "./driver";

function assets(): DataAssetCatalogEntry[] {
  return [
    { guid: "stats", name: "Stats", type: "Structure", payload: { fields: [
      { id: "health", name: "Health", typeId: "int" },
      { name: "Offset", typeId: "vec3" },
    ] } },
    { guid: "sword", name: "Sword", type: "DataObject", payload: createDataObjectAsset("stats", { Health: 20, Offset: { x: 1, y: 2, z: 3 } }) },
    { guid: "shield", name: "Shield", type: "DataObject", payload: createDataObjectAsset("stats", { Health: 50, Offset: { x: 4, y: 5, z: 6 } }) },
    { guid: "equipment", name: "Equipment", type: "DataSheet", payload: createDataSheetAsset("stats", ["shield", "sword"]) },
    { guid: "empty", name: "Empty", type: "DataSheet", payload: createDataSheetAsset("stats") },
  ];
}

function host(data?: RuntimeDataCatalog, logs: string[] = []): ScriptHost {
  const services: ScriptHostServices = {
    data,
    log: (_severity, _category, message) => { logs.push(message); },
    print: () => {}, destroyActor: () => {},
    executeConsoleCommand: () => ({ success: true, output: "" }),
    delay: async () => {}, reportError: () => {},
  };
  return new ScriptHost(services);
}

describe("runtime data catalog", () => {
  it("keeps objects and their sheets readable after optional asset and Class references are deleted", () => {
    const fields = [
      { name: "Icon", typeId: "asset", typeClassId: "Texture" },
      { name: "Spawn", typeId: "class" },
      { name: "Label", typeId: "string" },
    ];
    const authored = createDataObjectAsset("item", { Icon: "texture", Spawn: "Hero", Label: "texture" }, fields);
    const cleared = clearDeletedAssetRefs(authored, new Set(["texture", "hero-guid"]), new Set(["Hero"]));
    const data = new RuntimeDataCatalog([
      { guid: "item", type: "Structure", name: "Item", payload: { fields } },
      { guid: "sword", type: "DataObject", name: "Sword", payload: cleared.value },
      { guid: "items", type: "DataSheet", name: "Items", payload: createDataSheetAsset("item", ["sword"]) },
    ]);
    expect(data.readObject("sword")).toEqual({ Icon: "", Spawn: "", Label: "texture" });
    expect(data.hasSheet("items")).toBe(true);
    expect(data.getSheetObjects("items")).toEqual(["sword"]);
    expect(authored.values).toEqual({ Icon: "texture", Spawn: "Hero", Label: "texture" });
  });
  it("reads standalone objects and isolates nested values from other readers and the source asset", () => {
    const source = assets().filter((entry) => entry.type !== "DataSheet");
    const data = new RuntimeDataCatalog(source);
    const first = data.readObject("sword", "stats")!;
    (first.Offset as { x: number }).x = -1;
    first.Health = -1;
    const original = source.find((entry) => entry.guid === "sword")!.payload as ReturnType<typeof createDataObjectAsset>;
    original.values.Health = 999;
    expect(data.readObject("sword", "stats")).toEqual({ Health: 20, Offset: { x: 1, y: 2, z: 3 } });
    expect(data.hasObject("sword", "other-structure")).toBe(false);
    expect(data.readObject("sword", "other-structure")).toBeNull();
    expect(data.readObject("missing")).toBeNull();
    expect(data.readObject({ guid: "sword" })).toBeNull();
  });

  it("preserves sheet order, distinguishes an empty sheet from a miss, and rejects invalid membership", () => {
    const data = new RuntimeDataCatalog([
      ...assets(),
      { guid: "broken", name: "Broken", type: "DataSheet", payload: createDataSheetAsset("stats", ["missing", "sword"]) },
      { guid: "duplicate", name: "Duplicate", type: "DataSheet", payload: { kind: "dataSheet", structureGuid: "stats", objectGuids: ["sword", "sword"] } },
    ]);
    const references = data.getSheetObjects("equipment", "stats");
    references.reverse();
    expect(data.getSheetObjects("equipment")).toEqual(["shield", "sword"]);
    expect(data.getSheetObjects("equipment", "other-structure")).toEqual([]);
    expect(data.hasSheet("equipment", "other-structure")).toBe(false);
    expect(data.getSheetObjects("empty")).toEqual([]);
    expect(data.hasSheet("empty")).toBe(true);
    expect(data.hasSheet("missing")).toBe(false);
    expect(data.hasSheet("broken")).toBe(false);
    expect(data.hasSheet("duplicate")).toBe(false);
  });

  it("projects stable field renames and fails new missing fields without inheriting defaults", () => {
    const data = new RuntimeDataCatalog([
      { guid: "stats", name: "Stats", type: "Structure", payload: { fields: [{ id: "health", name: "MaxHealth", typeId: "int", defaultValue: 100 }] } },
      { guid: "renamed", name: "Renamed", type: "DataObject", payload: createDataObjectAsset("stats", { Health: 12 }, [{ id: "health", name: "Health", typeId: "int" }]) },
      { guid: "missing", name: "Missing", type: "DataObject", payload: createDataObjectAsset("stats", {}) },
      { guid: "invalid", name: "Invalid", type: "DataObject", payload: createDataObjectAsset("stats", { MaxHealth: "many" }) },
    ]);
    expect(data.readObject("renamed")).toEqual({ MaxHealth: 12 });
    expect(data.hasObject("missing")).toBe(false);
    expect(data.hasObject("invalid")).toBe(false);
  });

  it("executes compiled data nodes through the ScriptHost using worker-load snapshots", async () => {
    const registry = createDefaultNodeRegistry();
    const node = (id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode => ({
      id, typeId, position: { x: 0, y: 0 }, properties, pins: registry.get(typeId)!.pins(properties),
    });
    const graph: LogicGraph = {
      id: "data-read", kind: "event",
      nodes: [
        node("start", "flow.entry"),
        node("read", "data.readObject", { structGuid: "stats", "default:object": "sword" }),
        node("break", "struct.break", { structGuid: "stats", fields: [{ name: "Health", typeId: "int" }] }),
        node("log", "debug.log"),
      ],
      edges: [
        { id: "flow", sourceNodeId: "start", sourcePinId: "execOut", targetNodeId: "log", targetPinId: "execIn" },
        { id: "value", sourceNodeId: "read", sourcePinId: "value", targetNodeId: "break", targetPinId: "in" },
        { id: "health", sourceNodeId: "break", sourcePinId: "Health", targetNodeId: "log", targetPinId: "message" },
      ],
    };
    const options = runtimeOptionsFromLoadControl({ type: "load", sceneAssetGuid: "scene", dataAssets: assets() });
    const data = new RuntimeDataCatalog(options.dataAssets);
    const logs: string[] = [];
    const context = host(data, logs).createContext(null, 0, 0);
    const compiled = compileGraph(graph, { registry, assetGuid: "actor" });
    const module = await loadCompiledModule(compiled.source, "data-read");
    await module.run!(context);
    expect(logs).toEqual(["20"]);

    // Found is safe when the reference is missing; no Structure access runs.
    graph.edges = [graph.edges[0]!, { id: "found", sourceNodeId: "read", sourcePinId: "found", targetNodeId: "log", targetPinId: "message" }];
    graph.nodes.find((entry) => entry.id === "read")!.properties["default:object"] = "missing";
    const found = await loadCompiledModule(compileGraph(graph, { registry, assetGuid: "actor" }).source, "data-miss");
    await found.run!(context);
    expect(logs).toEqual(["20", "false"]);

    graph.nodes.push(node("sheet", "data.getSheetObjects", { structGuid: "stats", "default:sheet": "equipment" }));
    graph.edges = [graph.edges[0]!, { id: "objects", sourceNodeId: "sheet", sourcePinId: "objects", targetNodeId: "log", targetPinId: "message" }];
    const sheet = await loadCompiledModule(compileGraph(graph, { registry, assetGuid: "actor" }).source, "data-sheet");
    await sheet.run!(context);
    expect(logs.at(-1)).toContain("shield");
    expect(logs.at(-1)).toContain("sword");
  });

  it("denies editor data authoring in gameplay and safely misses data in hosts without a catalog", async () => {
    const context = host().createContext(null, 0, 0);
    expect(context.data.readObject("sword")).toBeNull();
    expect(context.data.hasSheet("empty")).toBe(false);
    expect(await context.editorData.updateObject("sword", "stats", { Health: 1 })).toMatchObject({ success: false, value: null });
  });

  it("installs loaded data into the actual runtime driver's authored graph context", async () => {
    const logs: string[] = [];
    const runtime = createInProcessRuntime({
      ...runtimeOptionsFromLoadControl({ type: "load", sceneAssetGuid: "scene", dataAssets: assets() }),
      seedDemoActors: false, preferSoftwarePhysics: true,
      onCommand: (command) => { if (command.type === "log" && command.category === "Data") logs.push(command.message); },
    });
    try {
      await runtime.loadScripts([{
        assetGuid: "reader", classId: "DataReader", anchors: [],
        source: 'export function onTick(ctx) { ctx.log("log", "Data", String(ctx.data.readObject("sword", "stats").Health)); }',
        entryPoints: [{ name: "onTick", event: "onTick", isAsync: false }],
      }]);
      runtime.spawnScriptedActor({ classId: "DataReader" });
      runtime.start();
      runtime.tick();
      expect(logs).toEqual(["20"]);
    } finally { runtime.stop(); }
  });
});
