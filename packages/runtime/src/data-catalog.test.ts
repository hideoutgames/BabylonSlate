import { describe, expect, it } from "vitest";
import { createDataSheetAsset, type DataAssetCatalogEntry, type DataDefinitionAsset } from "@babylonslate/core";
import { clearDeletedAssetRefs } from "@babylonslate/assets";
import { compileGraph, type GraphNode, type LogicGraph } from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { RuntimeDataCatalog } from "./data-catalog";
import { ScriptHost, type ScriptHostServices } from "./script-host";
import { loadCompiledModule } from "./module-loader";
import { runtimeOptionsFromLoadControl } from "./play-load";
import { createInProcessRuntime } from "./driver";

function definition(guid: string, fields: DataDefinitionAsset["fields"]): DataAssetCatalogEntry {
  return { guid, name: guid, type: "DataDefinition", payload: { kind: "dataDefinition", fields } };
}

function assets(): DataAssetCatalogEntry[] {
  return [
    definition("stats", [
      { id: "health", name: "Health", typeId: "int" },
      { id: "offset", name: "Offset", typeId: "vec3" },
    ]),
    { guid: "equipment", name: "Equipment", type: "DataSheet", payload: createDataSheetAsset("stats", [
      { id: "shield", name: "Shield", values: { Health: 50, Offset: { x: 4, y: 5, z: 6 } } },
      { id: "sword", name: "Sword", values: { Health: 20, Offset: { x: 1, y: 2, z: 3 } } },
    ]) },
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
  it("reads Tags, Tag Containers, nested arrays, and native Maps without sharing mutable data", () => {
    const data = new RuntimeDataCatalog([
      definition("bonus", [{ id: "power", name: "Power", typeId: "int" }]),
      definition("config", [
        { id: "state", name: "State", typeId: "tag" },
        { id: "tags", name: "Tags", typeId: "struct", typeClassId: "engine:TagContainer" },
        { id: "weights", name: "Weights", typeId: "float", container: "map", keyTypeId: "tag" },
        { id: "bonuses", name: "Bonuses", typeId: "struct", typeClassId: "bonus", container: "array" },
      ]),
      { guid: "items", name: "Items", type: "DataSheet", payload: createDataSheetAsset("config", [{
        id: "item", name: "Item", values: {
          State: 2, Tags: { Tags: [1, 2] },
          Weights: [{ key: 1, value: 0.5 }, { key: 2, value: 1.5 }],
          Bonuses: [{ Power: 3 }],
        },
      }]) },
    ]);
    const first = data.readRow("items", "item", "config")!;
    expect(first).toEqual({ State: 2, Tags: { Tags: [1, 2] }, Weights: new Map([[1, 0.5], [2, 1.5]]), Bonuses: [{ Power: 3 }] });
    (first.Weights as Map<number, number>).set(1, 99);
    (first.Tags as { Tags: number[] }).Tags.push(3);
    (first.Bonuses as Array<{ Power: number }>)[0]!.Power = 99;
    const next = data.readRow("items", "item", "config")!;
    expect((next.Weights as Map<number, number>).get(1)).toBe(0.5);
    expect(next.Tags).toEqual({ Tags: [1, 2] });
    expect(next.Bonuses).toEqual([{ Power: 3 }]);
  });

  it("keeps rows readable after optional asset and Class references are deleted", () => {
    const fields = [
      { id: "icon", name: "Icon", typeId: "asset", typeClassId: "Texture" },
      { id: "spawn", name: "Spawn", typeId: "class" },
      { id: "label", name: "Label", typeId: "string" },
    ];
    const authored = createDataSheetAsset("item", [{
      id: "sword", name: "Sword", values: { Icon: "texture", Spawn: "Hero", Label: "texture" }, schema: fields,
    }]);
    const cleared = clearDeletedAssetRefs(authored, new Set(["texture", "hero-guid"]), new Set(["Hero"]));
    const data = new RuntimeDataCatalog([
      definition("item", fields),
      { guid: "items", type: "DataSheet", name: "Items", payload: cleared.value },
    ]);
    expect(data.readRow("items", "sword")).toEqual({ Icon: "", Spawn: "", Label: "texture" });
    expect(data.hasSheet("items")).toBe(true);
    expect(data.getSheetRows("items")).toEqual(["sword"]);
    expect(authored.rows[0]!.values).toEqual({ Icon: "texture", Spawn: "Hero", Label: "texture" });
  });

  it("scopes IDs to their sheet and isolates nested values from readers and source assets", () => {
    const source = assets();
    source.push({ guid: "second", type: "DataSheet", name: "Second", payload: createDataSheetAsset("stats", [
      { id: "sword", name: "Another sword", values: { Health: 80, Offset: { x: 0, y: 0, z: 0 } } },
    ]) });
    const data = new RuntimeDataCatalog(source);
    const first = data.readRow("equipment", "sword", "stats")!;
    (first.Offset as { x: number }).x = -1;
    first.Health = -1;
    const original = source.find((entry) => entry.guid === "equipment")!.payload as ReturnType<typeof createDataSheetAsset>;
    original.rows[1]!.values.Health = 999;
    original.rows[1]!.name = "Renamed";
    expect(data.readRow("equipment", "sword", "stats")).toEqual({ Health: 20, Offset: { x: 1, y: 2, z: 3 } });
    expect(data.readRow("second", "sword")!.Health).toBe(80);
    expect(data.hasRow("equipment", "sword", "other-definition")).toBe(false);
    expect(data.readRow("equipment", "sword", "other-definition")).toBeNull();
    expect(data.readRow("equipment", "missing")).toBeNull();
    expect(data.readRow("equipment", "Sword")).toBeNull();
    expect(data.readRow("missing", "sword")).toBeNull();
    expect(data.readRow({ guid: "equipment" }, "sword")).toBeNull();
  });

  it("preserves row order, distinguishes empty sheets from misses, and rejects ambiguous identities", () => {
    const data = new RuntimeDataCatalog([
      ...assets(),
      { guid: "duplicate", name: "Duplicate", type: "DataSheet", payload: { kind: "dataSheet", definitionGuid: "stats", rows: [
        { id: "same", name: "One", values: {} }, { id: "same", name: "Two", values: {} },
      ] } },
      { guid: "blank-id", name: "Blank", type: "DataSheet", payload: { kind: "dataSheet", definitionGuid: "stats", rows: [
        { id: " ", name: "One", values: {} },
      ] } },
      { guid: "padded-id", name: "Padded", type: "DataSheet", payload: createDataSheetAsset("stats", [
        { id: " sword ", name: "Sword", values: { Health: 20, Offset: { x: 1, y: 2, z: 3 } } },
      ]) },
      { guid: "unknown-definition", name: "Unknown", type: "DataSheet", payload: createDataSheetAsset("missing") },
      { guid: "structure", name: "Structure", type: "Structure", payload: { fields: [] } },
      { guid: "wrong-kind", name: "Wrong kind", type: "DataSheet", payload: createDataSheetAsset("structure") },
    ]);
    const rowIds = data.getSheetRows("equipment", "stats");
    rowIds.reverse();
    expect(data.getSheetRows("equipment")).toEqual(["shield", "sword"]);
    expect(data.getSheetRows("equipment", "other-definition")).toEqual([]);
    expect(data.hasSheet("equipment", "other-definition")).toBe(false);
    expect(data.getSheetRows("empty")).toEqual([]);
    expect(data.hasSheet("empty")).toBe(true);
    for (const guid of ["missing", "duplicate", "blank-id", "padded-id", "unknown-definition", "wrong-kind"]) {
      expect(data.hasSheet(guid)).toBe(false);
    }
  });

  it("rejects invalid and cyclic Definitions even for empty sheets without hiding valid data", () => {
    const invalidDefinitions = ["invalid", "cycle-a", "cycle-b"];
    const data = new RuntimeDataCatalog([
      ...assets(),
      definition("invalid", [
        { id: "duplicate", name: "Health", typeId: "int" },
        { id: "duplicate", name: "Power", typeId: "int" },
      ]),
      definition("cycle-a", [{ id: "child", name: "Child", typeId: "struct", typeClassId: "cycle-b" }]),
      definition("cycle-b", [{ id: "children", name: "Children", typeId: "struct", typeClassId: "cycle-a", container: "array" }]),
      ...invalidDefinitions.flatMap((definitionGuid): DataAssetCatalogEntry[] => [
        { guid: `${definitionGuid}-empty`, type: "DataSheet", name: "Empty", payload: createDataSheetAsset(definitionGuid) },
        { guid: `${definitionGuid}-rows`, type: "DataSheet", name: "Rows", payload: createDataSheetAsset(definitionGuid, [
          { id: "row", name: "Row", values: { Health: 20, Power: 10, Child: { Children: [] }, Children: [] } },
        ]) },
      ]),
    ]);
    for (const definitionGuid of invalidDefinitions) {
      for (const suffix of ["empty", "rows"]) {
        const sheetGuid = `${definitionGuid}-${suffix}`;
        expect(data.hasSheet(sheetGuid)).toBe(false);
        expect(data.getSheetRows(sheetGuid)).toEqual([]);
        expect(data.hasRow(sheetGuid, "row")).toBe(false);
        expect(data.readRow(sheetGuid, "row")).toBeNull();
      }
    }
    expect(data.hasSheet("empty")).toBe(true);
    expect(data.readRow("equipment", "sword")!.Health).toBe(20);
  });

  it("projects stable field renames and isolates invalid rows without inheriting new defaults", () => {
    const data = new RuntimeDataCatalog([
      definition("stats", [{ id: "health", name: "MaxHealth", typeId: "int", defaultValue: 100 }]),
      { guid: "items", name: "Items", type: "DataSheet", payload: createDataSheetAsset("stats", [
        { id: "renamed", name: "Renamed", values: { Health: 12 }, schema: [{ id: "health", name: "Health", typeId: "int" }] },
        { id: "missing", name: "Missing", values: {} },
        { id: "invalid", name: "Invalid", values: { MaxHealth: "many" } },
      ]) },
    ]);
    expect(data.readRow("items", "renamed")).toEqual({ MaxHealth: 12 });
    expect(data.hasRow("items", "missing")).toBe(false);
    expect(data.hasRow("items", "invalid")).toBe(false);
    expect(data.readRow("items", "invalid")).toBeNull();
    expect(data.hasSheet("items")).toBe(true);
    expect(data.getSheetRows("items")).toEqual(["renamed", "missing", "invalid"]);
  });

  it("keeps valid siblings readable when an external row has malformed values", () => {
    const data = new RuntimeDataCatalog([
      definition("stats", [{ id: "health", name: "Health", typeId: "int" }]),
      { guid: "items", type: "DataSheet", name: "Items", payload: { kind: "dataSheet", definitionGuid: "stats", rows: [
        { id: "broken", name: "Broken", values: null },
        { id: "valid", name: "Valid", values: { Health: 12 } },
      ] } },
    ]);
    expect(data.hasSheet("items")).toBe(true);
    expect(data.getSheetRows("items")).toEqual(["broken", "valid"]);
    expect(data.readRow("items", "broken")).toBeNull();
    expect(data.readRow("items", "valid")).toEqual({ Health: 12 });
  });

  it("executes compiled row nodes through the ScriptHost using worker-load snapshots", async () => {
    const registry = createDefaultNodeRegistry();
    const node = (id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode => ({
      id, typeId, position: { x: 0, y: 0 }, properties, pins: registry.get(typeId)!.pins(properties),
    });
    const graph: LogicGraph = {
      id: "data-read", kind: "event",
      nodes: [
        node("start", "flow.entry"),
        node("read", "data.readRow", { definitionGuid: "stats", "default:sheet": "equipment", "default:rowId": "sword" }),
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

    // Found is safe when the row is missing; no typed field access runs.
    graph.edges = [graph.edges[0]!, { id: "found", sourceNodeId: "read", sourcePinId: "found", targetNodeId: "log", targetPinId: "message" }];
    graph.nodes.find((entry) => entry.id === "read")!.properties["default:rowId"] = "missing";
    const found = await loadCompiledModule(compileGraph(graph, { registry, assetGuid: "actor" }).source, "data-miss");
    await found.run!(context);
    expect(logs).toEqual(["20", "false"]);

    graph.nodes.push(node("sheet", "data.getSheetRows", { definitionGuid: "stats", "default:sheet": "equipment" }));
    graph.edges = [graph.edges[0]!, { id: "rows", sourceNodeId: "sheet", sourcePinId: "rows", targetNodeId: "log", targetPinId: "message" }];
    const sheet = await loadCompiledModule(compileGraph(graph, { registry, assetGuid: "actor" }).source, "data-sheet");
    await sheet.run!(context);
    expect(logs.at(-1)).toContain("shield");
    expect(logs.at(-1)).toContain("sword");
  });

  it("denies editor data authoring in gameplay and safely misses data in hosts without a catalog", async () => {
    const context = host().createContext(null, 0, 0);
    expect(context.data.readRow("equipment", "sword")).toBeNull();
    expect(context.data.hasSheet("empty")).toBe(false);
    expect(await context.editorData.updateRow("equipment", "sword", "stats", { Health: 1 })).toMatchObject({ success: false, value: null });
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
        source: 'export function onTick(ctx) { ctx.log("log", "Data", String(ctx.data.readRow("equipment", "sword", "stats").Health)); }',
        entryPoints: [{ name: "onTick", event: "onTick", isAsync: false }],
      }]);
      runtime.spawnScriptedActor({ classId: "DataReader" });
      runtime.start();
      runtime.tick();
      expect(logs).toEqual(["20"]);
    } finally { runtime.stop(); }
  });
});
