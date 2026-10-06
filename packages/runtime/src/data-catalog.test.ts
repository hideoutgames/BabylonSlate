import { describe, expect, it } from "vitest";
import { createDataTreeAsset, createDataTreeEntry, type DataAssetCatalogEntry, type DataDefinitionAsset, type DataTreeEntry } from "@babylonslate/core";
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

function tree(guid: string, defaultDefinitionGuid: string | null, entries: DataTreeEntry[] = []): DataAssetCatalogEntry {
  return { guid, name: guid, type: "DataTree", payload: createDataTreeAsset(defaultDefinitionGuid, entries) };
}

function stats(health: number) {
  return { Health: health, Offset: { x: 1, y: 2, z: 3 } };
}

function assets(): DataAssetCatalogEntry[] {
  return [
    definition("stats", [
      { id: "health", name: "Health", typeId: "int" },
      { id: "offset", name: "Offset", typeId: "vec3" },
    ]),
    tree("equipment", "stats", [
      createDataTreeEntry({ id: "weapons", name: "Weapons", definitionGuid: null, values: stats(999) }),
      createDataTreeEntry({ id: "armor", name: "Armor", values: stats(70) }),
      createDataTreeEntry({ id: "swords", name: "Swords", parentId: "weapons", definitionGuid: "stats", values: stats(30) }),
      createDataTreeEntry({ id: "shield", name: "Shield", parentId: "weapons", definitionGuid: "stats", values: stats(50) }),
      createDataTreeEntry({ id: "sword", name: "Iron Sword", parentId: "swords", values: stats(20) }),
      createDataTreeEntry({ id: "replica", name: "Iron Sword", parentId: "armor", values: stats(80) }),
    ]),
    tree("empty", "stats"),
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
  it("indexes root, children, preorder descendants and parents independently of stored entry order", () => {
    const data = new RuntimeDataCatalog(assets());
    expect(data.getChildren("equipment")).toEqual(["Weapons", "Armor"]);
    expect(data.getChildren("equipment", "Weapons")).toEqual(["Weapons/Swords", "Weapons/Shield"]);
    expect(data.getDescendants("equipment")).toEqual([
      "Weapons", "Weapons/Swords", "Weapons/Swords/Iron Sword", "Weapons/Shield", "Armor", "Armor/Iron Sword",
    ]);
    expect(data.getDescendants("equipment", "Weapons")).toEqual(["Weapons/Swords", "Weapons/Swords/Iron Sword", "Weapons/Shield"]);
    expect(data.getDescendants("equipment", "Weapons/Swords/Iron Sword")).toEqual([]);
    expect(data.getParent("equipment", "Weapons/Swords/Iron Sword")).toBe("Weapons/Swords");
    expect(data.getParent("equipment", "Weapons")).toBe("");
    expect(data.getParent("equipment", "")).toBeNull();
    expect(data.hasEntry("equipment", "")).toBe(false);
    expect(data.hasEntry("equipment", "Weapons")).toBe(true);
    expect(data.canReadEntry("equipment", "Weapons")).toBe(false);
    expect(data.hasTree("empty")).toBe(true);
    expect(data.getChildren("empty")).toEqual([]);
    expect(data.getDescendants("empty")).toEqual([]);
    data.getChildren("equipment").reverse();
    data.getDescendants("equipment", "Weapons").splice(0);
    expect(data.getChildren("equipment")).toEqual(["Weapons", "Armor"]);
    expect(data.getDescendants("equipment", "Weapons")).toHaveLength(3);
  });

  it("uses exact paths without ID, leaf, case, whitespace or slash fallback", () => {
    const data = new RuntimeDataCatalog(assets());
    expect(data.readEntry("equipment", "Weapons/Swords/Iron Sword", "stats")).toEqual(stats(20));
    expect(data.readEntry("equipment", "Armor/Iron Sword")!.Health).toBe(80);
    expect(data.readEntry("equipment", "Weapons/Swords/Iron Sword", "other-definition")).toBeNull();
    expect(data.canReadEntry("equipment", "Weapons/Swords/Iron Sword", "other-definition")).toBe(false);
    for (const path of ["sword", "Iron Sword", "/Weapons", "Weapons/", "weapons", " Weapons ", "Weapons//Swords", "missing", null, { path: "Weapons" }]) {
      expect(data.hasEntry("equipment", path)).toBe(false);
      expect(data.readEntry("equipment", path)).toBeNull();
      expect(data.getChildren("equipment", path)).toEqual([]);
      expect(data.getDescendants("equipment", path)).toEqual([]);
      expect(data.getParent("equipment", path)).toBeNull();
    }
    expect(data.hasTree({ guid: "equipment" })).toBe(false);
    expect(data.hasTree("missing")).toBe(false);
    expect(data.getChildren("missing")).toEqual([]);
  });

  it("inherits only Definitions, supports mixed overrides, and never inherits parent values or new defaults", () => {
    const data = new RuntimeDataCatalog([
      definition("stats", [{ id: "health", name: "Health", typeId: "int", defaultValue: 100 }]),
      definition("price", [{ id: "price", name: "Price", typeId: "float" }]),
      tree("items", "stats", [
        createDataTreeEntry({ id: "root", name: "Root", values: { Health: 30 } }),
        createDataTreeEntry({ id: "own", name: "Own", parentId: "root", values: { Health: 12 } }),
        createDataTreeEntry({ id: "missing", name: "Missing", parentId: "root", values: {} }),
        createDataTreeEntry({ id: "group", name: "Group", parentId: "root", definitionGuid: null, values: { Health: 70 } }),
        createDataTreeEntry({ id: "untyped", name: "Untyped", parentId: "group", values: { Health: 8 } }),
        createDataTreeEntry({ id: "cost", name: "Cost", parentId: "group", definitionGuid: "price", values: { Price: 2.5 } }),
      ]),
    ]);
    expect(data.readEntry("items", "Root/Own", "stats")).toEqual({ Health: 12 });
    expect(data.readEntry("items", "Root/Missing")).toBeNull();
    expect(data.readEntry("items", "Root/Group")).toBeNull();
    expect(data.hasEntry("items", "Root/Group/Untyped")).toBe(true);
    expect(data.readEntry("items", "Root/Group/Untyped")).toBeNull();
    expect(data.readEntry("items", "Root/Group/Cost", "price")).toEqual({ Price: 2.5 });
    expect(data.readEntry("items", "Root/Group/Cost", "stats")).toBeNull();
  });

  it("reads Tags, Tag Containers, nested arrays and native Maps with detached values", () => {
    const source = [
      definition("bonus", [{ id: "power", name: "Power", typeId: "int" }]),
      definition("config", [
        { id: "state", name: "State", typeId: "tag" },
        { id: "tags", name: "Tags", typeId: "struct", typeClassId: "engine:TagContainer" },
        { id: "weights", name: "Weights", typeId: "float", container: "map", keyTypeId: "tag" },
        { id: "bonuses", name: "Bonuses", typeId: "struct", typeClassId: "bonus", container: "array" },
      ]),
      tree("items", "config", [createDataTreeEntry({ id: "item", name: "Item", values: {
        State: 2, Tags: { Tags: [1, 2] }, Weights: [{ key: 1, value: 0.5 }, { key: 2, value: 1.5 }], Bonuses: [{ Power: 3 }],
      } })]),
    ];
    const data = new RuntimeDataCatalog(source);
    const first = data.readEntry("items", "Item", "config")!;
    expect(first).toEqual({ State: 2, Tags: { Tags: [1, 2] }, Weights: new Map([[1, 0.5], [2, 1.5]]), Bonuses: [{ Power: 3 }] });
    (first.Weights as Map<number, number>).set(1, 99);
    (first.Tags as { Tags: number[] }).Tags.push(3);
    (first.Bonuses as Array<{ Power: number }>)[0]!.Power = 99;
    const authored = source.at(-1)!.payload as ReturnType<typeof createDataTreeAsset>;
    authored.entries[0]!.values.State = 99;
    const next = data.readEntry("items", "Item", "config")!;
    expect(next.State).toBe(2);
    expect((next.Weights as Map<number, number>).get(1)).toBe(0.5);
    expect(next.Tags).toEqual({ Tags: [1, 2] });
    expect(next.Bonuses).toEqual([{ Power: 3 }]);
  });

  it("changes subtree paths after rename or move without exposing old paths or changing internal IDs", () => {
    const source = assets();
    const before = new RuntimeDataCatalog(source);
    const authored = source.find((entry) => entry.guid === "equipment")!.payload as ReturnType<typeof createDataTreeAsset>;
    const branch = authored.entries.find((entry) => entry.id === "swords")!;
    branch.name = "Blades";
    branch.parentId = "armor";
    const after = new RuntimeDataCatalog(source);
    expect(branch.id).toBe("swords");
    expect(authored.entries.find((entry) => entry.id === "sword")!.parentId).toBe("swords");
    expect(before.readEntry("equipment", "Weapons/Swords/Iron Sword")!.Health).toBe(20);
    expect(after.hasEntry("equipment", "Weapons/Swords")).toBe(false);
    expect(after.readEntry("equipment", "Weapons/Swords/Iron Sword")).toBeNull();
    expect(after.readEntry("equipment", "Armor/Blades/Iron Sword")!.Health).toBe(20);
    expect(after.getParent("equipment", "Armor/Blades")).toBe("Armor");
    expect(after.getChildren("equipment", "Weapons")).toEqual(["Weapons/Shield"]);
  });

  it("rejects malformed topology while leaving unrelated trees usable", () => {
    const malformed = [
      [createDataTreeEntry({ id: "same", name: "One" }), createDataTreeEntry({ id: "same", name: "Two" })],
      [createDataTreeEntry({ id: "one", name: "Shared" }), createDataTreeEntry({ id: "two", name: "shared" })],
      [createDataTreeEntry({ id: "one", name: "Missing Parent", parentId: "missing" })],
      [createDataTreeEntry({ id: "one", name: "One", parentId: "two" }), createDataTreeEntry({ id: "two", name: "Two", parentId: "one" })],
      [createDataTreeEntry({ id: "one", name: "Invalid/Name" })],
    ];
    const data = new RuntimeDataCatalog([...assets(), ...malformed.map((entries, index) => tree(`invalid-${index}`, null, entries))]);
    malformed.forEach((_, index) => {
      const guid = `invalid-${index}`;
      expect(data.hasTree(guid)).toBe(false);
      expect(data.getChildren(guid)).toEqual([]);
      expect(data.getDescendants(guid)).toEqual([]);
      expect(data.readEntry(guid, "One")).toBeNull();
    });
    expect(data.readEntry("equipment", "Weapons/Swords/Iron Sword")!.Health).toBe(20);
  });

  it("keeps navigation for invalid Definitions and entry values while valid overrides remain readable", () => {
    const malformed = tree("items", "invalid", [
      createDataTreeEntry({ id: "root", name: "Root", values: { Health: 20 } }),
      createDataTreeEntry({ id: "cycle", name: "Cycle", parentId: "root", definitionGuid: "cycle", values: {} }),
      createDataTreeEntry({ id: "missing", name: "Missing", parentId: "root", definitionGuid: "missing", values: {} }),
      createDataTreeEntry({ id: "valid", name: "Valid", parentId: "root", definitionGuid: "stats", values: stats(12) }),
      createDataTreeEntry({ id: "bad", name: "Bad", parentId: "root", definitionGuid: "stats", values: {} }),
    ]);
    (malformed.payload as ReturnType<typeof createDataTreeAsset>).entries[4]!.values = null as unknown as Record<string, unknown>;
    const data = new RuntimeDataCatalog([
      ...assets(),
      definition("invalid", [{ id: "duplicate", name: "Health", typeId: "int" }, { id: "duplicate", name: "Power", typeId: "int" }]),
      definition("cycle", [{ id: "next", name: "Next", typeId: "struct", typeClassId: "cycle", container: "array" }]),
      malformed, tree("invalid-default-empty", "invalid"),
    ]);
    expect(data.hasTree("invalid-default-empty")).toBe(true);
    expect(data.hasTree("items")).toBe(true);
    expect(data.getChildren("items", "Root")).toEqual(["Root/Cycle", "Root/Missing", "Root/Valid", "Root/Bad"]);
    for (const path of ["Root", "Root/Cycle", "Root/Missing", "Root/Bad"]) {
      expect(data.hasEntry("items", path)).toBe(true);
      expect(data.canReadEntry("items", path)).toBe(false);
      expect(data.readEntry("items", path)).toBeNull();
    }
    expect(data.readEntry("items", "Root/Valid")).toEqual(stats(12));
  });

  it("projects stable field renames without inheriting new defaults", () => {
    const data = new RuntimeDataCatalog([
      definition("stats", [{ id: "health", name: "MaxHealth", typeId: "int", defaultValue: 100 }]),
      tree("items", "stats", [
        createDataTreeEntry({ id: "renamed", name: "Renamed", values: { Health: 12 }, schema: [{ id: "health", name: "Health", typeId: "int" }] }),
        createDataTreeEntry({ id: "missing", name: "Missing" }),
      ]),
    ]);
    expect(data.readEntry("items", "Renamed")).toEqual({ MaxHealth: 12 });
    expect(data.canReadEntry("items", "Missing")).toBe(false);
    expect(data.getChildren("items")).toEqual(["Renamed", "Missing"]);
  });

  it("keeps typed entries readable after optional asset and Class references are deleted", () => {
    const fields = [
      { id: "icon", name: "Icon", typeId: "asset", typeClassId: "Texture" },
      { id: "spawn", name: "Spawn", typeId: "class" },
      { id: "label", name: "Label", typeId: "string" },
    ];
    const authored = createDataTreeAsset("item", [createDataTreeEntry({ id: "sword", name: "Sword", values: { Icon: "texture", Spawn: "Hero", Label: "texture" }, schema: fields })]);
    const cleared = clearDeletedAssetRefs(authored, new Set(["texture", "hero-guid"]), new Set(["Hero"]));
    const data = new RuntimeDataCatalog([definition("item", fields), { guid: "items", type: "DataTree", name: "Items", payload: cleared.value }]);
    expect(data.readEntry("items", "Sword")).toEqual({ Icon: "", Spawn: "", Label: "texture" });
    expect(authored.entries[0]!.values).toEqual({ Icon: "texture", Spawn: "Hero", Label: "texture" });
  });

  it("executes compiled typed reads and all navigation nodes through the ScriptHost", async () => {
    const registry = createDefaultNodeRegistry();
    const node = (id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode => ({
      id, typeId, position: { x: 0, y: 0 }, properties, pins: registry.get(typeId)!.pins(properties),
    });
    const data = new RuntimeDataCatalog(runtimeOptionsFromLoadControl({ type: "load", sceneAssetGuid: "scene", dataAssets: assets() }).dataAssets);
    const logs: string[] = [];
    const context = host(data, logs).createContext(null, 0, 0);
    const graph: LogicGraph = {
      id: "data-read", kind: "event",
      nodes: [node("start", "flow.entry"), node("read", "data.readEntry", { definitionGuid: "stats", "default:tree": "equipment", "default:entryPath": "Weapons/Swords/Iron Sword" }), node("break", "struct.break", { structGuid: "stats", fields: [{ name: "Health", typeId: "int" }] }), node("log", "debug.log")],
      edges: [
        { id: "flow", sourceNodeId: "start", sourcePinId: "execOut", targetNodeId: "log", targetPinId: "execIn" },
        { id: "value", sourceNodeId: "read", sourcePinId: "value", targetNodeId: "break", targetPinId: "in" },
        { id: "health", sourceNodeId: "break", sourcePinId: "Health", targetNodeId: "log", targetPinId: "message" },
      ],
    };
    await (await loadCompiledModule(compileGraph(graph, { registry, assetGuid: "actor" }).source, "data-read")).run!(context);
    expect(logs).toEqual(["20"]);
    const runOutput = async (typeId: string, path: string, output: string) => {
      graph.nodes = [node("start", "flow.entry"), node("read", typeId, { definitionGuid: "stats", "default:tree": "equipment", "default:entryPath": path }), node("log", "debug.log")];
      graph.edges = [graph.edges[0]!, { id: "output", sourceNodeId: "read", sourcePinId: output, targetNodeId: "log", targetPinId: "message" }];
      await (await loadCompiledModule(compileGraph(graph, { registry, assetGuid: "actor" }).source, `${typeId}-${output}`)).run!(context);
      return logs.at(-1);
    };
    expect(await runOutput("data.readEntry", "Weapons", "found")).toBe("false");
    expect(await runOutput("data.getChildren", "", "found")).toBe("true");
    expect(await runOutput("data.getChildren", "missing", "found")).toBe("false");
    expect(await runOutput("data.getChildren", "Weapons", "paths")).toContain("Weapons/Shield");
    expect(await runOutput("data.getDescendants", "Weapons", "paths")).toContain("Weapons/Swords/Iron Sword");
    expect(await runOutput("data.getParent", "Weapons/Swords", "parentPath")).toBe("Weapons");
    expect(await runOutput("data.getParent", "Weapons", "found")).toBe("true");
    expect(await runOutput("data.getParent", "", "found")).toBe("false");
  });

  it("denies editor data authoring in gameplay and safely misses in hosts without a catalog", async () => {
    const context = host().createContext(null, 0, 0);
    expect(context.data.readEntry("equipment", "Weapons/Swords/Iron Sword")).toBeNull();
    expect(context.data.hasTree("empty")).toBe(false);
    expect(await context.editorData.updateEntry("equipment", "Weapons/Swords/Iron Sword", "stats", { Health: 1 })).toMatchObject({ success: false, value: null });
  });

  it("installs loaded trees into the actual runtime driver's authored graph context", async () => {
    const logs: string[] = [];
    const runtime = createInProcessRuntime({
      ...runtimeOptionsFromLoadControl({ type: "load", sceneAssetGuid: "scene", dataAssets: assets() }),
      seedDemoActors: false, preferSoftwarePhysics: true,
      onCommand: (command) => { if (command.type === "log" && command.category === "Data") logs.push(command.message); },
    });
    try {
      await runtime.loadScripts([{
        assetGuid: "reader", classId: "DataReader", anchors: [],
        source: 'export function onTick(ctx) { ctx.log("log", "Data", String(ctx.data.readEntry("equipment", "Weapons/Swords/Iron Sword", "stats").Health)); }',
        entryPoints: [{ name: "onTick", event: "onTick", isAsync: false }],
      }]);
      runtime.spawnScriptedActor({ classId: "DataReader" });
      runtime.start();
      runtime.tick();
      expect(logs).toEqual(["20"]);
    } finally { runtime.stop(); }
  });
});
