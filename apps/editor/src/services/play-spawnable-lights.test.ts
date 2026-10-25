import { describe, expect, it } from "vitest";
import type { ScriptBundleEntry } from "@haptic/bridge";
import { compileGraph, type GraphNode, type LogicGraph, type NodeRegistry } from "@haptic/scripting";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import { spawnableLightsOfLoad } from "@haptic/render/spawnable-lights";

function node(registry: NodeRegistry, id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode {
  const definition = registry.get(typeId);
  if (!definition) throw new Error(`missing node ${typeId}`);
  return { id, typeId, position: { x: 0, y: 0 }, pins: definition.pins(properties), properties };
}

/** A Class whose Begin Play runs Spawn Actor, its Class named on the node or fed by a Class variable. */
function spawner(registry: NodeRegistry, spawned: { named: string } | "variable"): ScriptBundleEntry {
  const nodes = [
    node(registry, "begin", "flow.event.beginPlay"),
    node(registry, "spawn", "actor.spawn", spawned === "variable" ? {} : { "default:classId": spawned.named }),
  ];
  const edges = [{ id: "exec", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "spawn", targetPinId: "execIn" }];
  if (spawned === "variable") {
    nodes.push(node(registry, "class", "variables.get", { variableName: "Pickup", typeId: "class", typeClassId: "Actor", implicitSelf: true }));
    edges.push({ id: "class", sourceNodeId: "class", sourcePinId: "value", targetNodeId: "spawn", targetPinId: "classId" });
  }
  const graph: LogicGraph = { id: "g", kind: "event", nodes, edges };
  return { assetGuid: "spawner", classId: "Spawner", source: compileGraph(graph, { assetGuid: "spawner", registry }).source, anchors: [], entryPoints: [] };
}

/** A Class with no light of its own. */
const plain = (classId: string): ScriptBundleEntry => ({ assetGuid: classId.toLowerCase(), classId, source: "", anchors: [], entryPoints: [] });

describe("the lights a Play load may spawn", () => {
  // Editor Play and the player pass each source preparation's compiled Classes and catalog entries; a Spawn Actor's
  // compiled call tells whether its Class is one the load holds.
  it.each([
    ["names a Class the load holds", { named: "Torch" } as const, [plain("Torch")], false],
    ["names a Class the load does not hold", { named: "Torch" } as const, [], true],
    ["takes its Class from a variable", "variable" as const, [plain("Torch")], true],
  ])("adds a point and a spot, each with and without shadows, when a Spawn Actor %s", (_, spawned, held, generic) => {
    const registry = createDefaultNodeRegistry();
    const lights = spawnableLightsOfLoad({ scripts: [spawner(registry, spawned), ...held], assets: [], isClass: () => true });
    expect([...lights.values()].map(({ kind, properties }) => `${kind}${properties.castShadows ? " shadows" : ""}`).sort())
      .toEqual(generic ? ["point", "point shadows", "spot", "spot shadows"] : []);
  });

  it("adds them when an asset of the load depends on a Class asset it does not hold, and not for one it holds", () => {
    // A Load On Demand reference (a Class variable's or a data asset's value) names a Class the load may spawn later.
    const scripts = [plain("Torch")];
    const kinds = (dependencies: string[]) => spawnableLightsOfLoad({
      scripts, assets: [{ guid: "scene", dependencies }], isClass: (guid) => guid === "torch" || guid === "lamp",
    }).size;
    expect([kinds(["torch", "material"]), kinds(["lamp"])]).toEqual([0, 4]);
  });
});
