import { describe, expect, it } from "vitest";
import {
  arrayOf,
  classRef,
  compileGraph,
  validateGraphs,
  type ClassHierarchy,
  type GraphEdge,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { ASSET_REGISTRY_BY_CLASS_NODE_ID } from "./asset-registry";
import { createDefaultNodeRegistry } from "./index";

function node(
  registry: NodeRegistry,
  id: string,
  typeId: string,
  properties: Record<string, unknown> = {},
): GraphNode {
  const def = registry.get(typeId);
  if (!def) throw new Error(`missing node ${typeId}`);
  return { id, typeId, position: { x: 0, y: 0 }, pins: def.pins(properties), properties };
}

const edge = (from: string, fromPin: string, to: string, toPin: string): GraphEdge => ({
  id: `${from}.${fromPin}->${to}.${toPin}`,
  sourceNodeId: from,
  sourcePinId: fromPin,
  targetNodeId: to,
  targetPinId: toPin,
});

const PARENT_OF: Record<string, string> = {
  Sniper: "Rifle",
  Rifle: "Weapon",
  Weapon: "Actor",
  Actor: "BObject",
  Inventory: "BObject",
};
const hierarchy: ClassHierarchy = {
  isSubclassOf(child, parent) {
    for (let id: string | undefined = child; id; id = PARENT_OF[id]) if (id === parent) return true;
    return false;
  },
};

describe("Get Assets By Class", () => {
  const registry = createDefaultNodeRegistry();
  const def = registry.get(ASSET_REGISTRY_BY_CLASS_NODE_ID)!;
  const classesPin = (properties: Record<string, unknown>) =>
    def.pins(properties).find((pin) => pin.id === "classes")!;

  it("types Classes from the picked Class, as Cast types its result", () => {
    expect(classesPin({ "default:class": "Rifle" }).type).toEqual(arrayOf(classRef("Rifle")));
    expect(classesPin({}).type).toEqual(arrayOf(classRef("BObject")));
    expect(def.pins({ "default:class": "Rifle" }).find((pin) => pin.id === "class")!.type).toEqual(classRef("BObject"));
  });

  function spawnGraph(properties: Record<string, unknown>): LogicGraph {
    return {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "query", ASSET_REGISTRY_BY_CLASS_NODE_ID, properties),
        node(registry, "each", "flow.forEach"),
        node(registry, "spawn", "actor.spawn"),
      ],
      edges: [
        edge("begin", "execOut", "each", "execIn"),
        edge("each", "loopBody", "spawn", "execIn"),
        edge("query", "classes", "each", "array"),
        edge("each", "element", "spawn", "classId"),
      ],
    };
  }
  const mismatches = (properties: Record<string, unknown>) =>
    validateGraphs([spawnGraph(properties)], { assetGuid: "a", hierarchy }, { registry }).filter(
      (diagnostic) => diagnostic.code === "type.mismatch" && diagnostic.nodeId === "spawn",
    );

  it("feeds Spawn Actor when the picked Class inherits from Actor", () => {
    expect(mismatches({ "default:class": "Rifle" })).toEqual([]);
    expect(mismatches({ "default:class": "Actor" })).toEqual([]);
  });

  it("does not feed Spawn Actor when the picked Class is not an Actor", () => {
    expect(mismatches({ "default:class": "Inventory" })).toHaveLength(1);
    expect(mismatches({})).toHaveLength(1);
  });
});

describe("Asset Registry codegen", () => {
  const registry = createDefaultNodeRegistry();

  /** Compile a query node wired into Log and report the `ctx.assetRegistry` calls it makes. */
  function callsFor(typeId: string, properties: Record<string, unknown>, output: string) {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [node(registry, "start", "flow.entry"), node(registry, "query", typeId, properties), node(registry, "log", "debug.log")],
      edges: [edge("start", "execOut", "log", "execIn"), edge("query", output, "log", "message")],
    };
    const body = compileGraph(graph, { assetGuid: "a", registry }).source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
    const calls: Array<[string, unknown[]]> = [];
    const assetRegistry = new Proxy({}, {
      get: (_target, method) => (...args: unknown[]) => {
        calls.push([String(method), args]);
        return [];
      },
    });
    (new Function(`${body}\nreturn { run };`)() as { run: (ctx: unknown) => void }).run({
      assetRegistry,
      formatValue: String,
      log: () => {},
    });
    return calls;
  }

  it.each([
    ["assetRegistry.getAssetData", { "default:asset": "g1" }, "assetData", [["getAssetData", ["g1"]]]],
    ["assetRegistry.getAssetData", { "default:asset": "g1" }, "found", [["hasAsset", ["g1"]]]],
    ["assetRegistry.getAssetByPath", { "default:path": "assets/A.texture.babasset" }, "assetData", [["getAssetByPath", ["assets/A.texture.babasset"]]]],
    ["assetRegistry.getAssetByPath", { "default:path": "assets/A.texture.babasset" }, "found", [["hasAssetPath", ["assets/A.texture.babasset"]]]],
    ["assetRegistry.getAssetsByPath", { "default:folder": "assets/A" }, "assets", [["getAssetsByPath", ["assets/A", false]]]],
    ["assetRegistry.getAssetsByType", { "default:type": "Texture", "default:folder": "assets" }, "assets", [["getAssetsByType", ["Texture", "assets", true]]]],
    ["assetRegistry.getAssetsByClass", { "default:class": "Rifle" }, "assets", [["getAssetsByClass", ["Rifle", true, "", true]]]],
    ["assetRegistry.getAssetsByClass", { "default:class": "Rifle", "default:includeSubclasses": false }, "classes", [["getAssetsByClass", ["Rifle", false, "", true]]]],
    ["assetRegistry.findAssets", { "default:filter": { Folders: ["assets"] } }, "assets", [["findAssets", [{ Folders: ["assets"] }]]]],
    ["assetRegistry.getSubFolders", { "default:folder": "assets" }, "folders", [["getSubFolders", ["assets", false]]]],
    ["assetRegistry.folderHasAssets", { "default:folder": "assets" }, "hasAssets", [["folderHasAssets", ["assets", true]]]],
    ["assetRegistry.getDependencies", { "default:asset": "g1" }, "assets", [["getDependencies", ["g1", false]]]],
    ["assetRegistry.getDependencies", { "default:asset": "g1", "default:hardOnly": true }, "assets", [["getDependencies", ["g1", true]]]],
    ["assetRegistry.getReferencers", { "default:asset": "g1", "default:hardOnly": true }, "assets", [["getReferencers", ["g1", true]]]],
  ] as const)("%s %j reads %s through ctx.assetRegistry", (typeId, properties, output, expected) => {
    expect(callsFor(typeId, properties, output)).toEqual(expected);
  });
});
