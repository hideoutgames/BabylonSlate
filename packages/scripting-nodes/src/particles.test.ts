import { describe, expect, it } from "vitest";
import {
  compileGraph,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@haptic/scripting";
import { createDefaultNodeRegistry, particleNodes } from "./index";

function node(
  registry: NodeRegistry,
  id: string,
  typeId: string,
  properties: Record<string, unknown> = {},
): GraphNode {
  const def = registry.get(typeId);
  if (!def) throw new Error(`missing node ${typeId}`);
  return {
    id,
    typeId,
    position: { x: 0, y: 0 },
    pins: def.pins(properties),
    properties,
  };
}

describe("particle nodes", () => {
  it("offers only the Spawn nodes; everything else is a Particle component function", () => {
    expect(particleNodes.map((definition) => definition.id)).toEqual([
      "particles.spawnAtLocation",
      "particles.spawnAttached",
    ]);
    const registry = createDefaultNodeRegistry();
    for (const removed of ["particles.play", "particles.stop", "particles.restart", "particles.isPlaying",
      "particles.emitBurst", "particles.setFloatParameter", "particles.getFloatParameter", "particles.resetParameter"]) {
      expect(registry.get(removed), removed).toBeUndefined();
    }
  });

  it("Spawn Particles nodes return the effect and default to Scale 1, no bone and Auto Destroy", () => {
    const registry = createDefaultNodeRegistry();
    const run = (typeId: string, properties: Record<string, unknown>) => {
      const graph: LogicGraph = {
        id: "g",
        kind: "event",
        nodes: [node(registry, "begin", "flow.event.beginPlay"), node(registry, "spawn", typeId, properties), node(registry, "log", "debug.log")],
        edges: [
          { id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "spawn", targetPinId: "execIn" },
          { id: "e2", sourceNodeId: "spawn", sourcePinId: "execOut", targetNodeId: "log", targetPinId: "execIn" },
          { id: "e3", sourceNodeId: "spawn", sourcePinId: "effect", targetNodeId: "log", targetPinId: "message" },
        ],
      };
      const body = compileGraph(graph, { assetGuid: "a", registry }).source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
      const mod = new Function(`${body}\nreturn { onBeginPlay };`)() as { onBeginPlay: (ctx: unknown) => void };
      const calls: unknown[][] = [];
      const logged: unknown[] = [];
      const effect = { guid: "effect" };
      mod.onBeginPlay({
        self: { guid: "self" },
        formatValue: (value: unknown) => value,
        log: (_severity: string, _category: string, value: unknown) => logged.push(value),
        spawnParticlesAtLocation: (...args: unknown[]) => { calls.push(args); return effect; },
        spawnParticlesAttached: (...args: unknown[]) => { calls.push(args); return effect; },
      });
      expect(logged).toEqual([effect]);
      return calls[0]!;
    };
    const at = run("particles.spawnAtLocation", { "default:system": "sparks" });
    expect([at[0], at[3], at[4]]).toEqual(["sparks", { x: 1, y: 1, z: 1 }, true]);
    const attached = run("particles.spawnAttached", { "default:system": "sparks", "default:autoDestroy": false });
    expect([attached[0], attached[2], attached[5]]).toEqual(["sparks", "", false]);
  });

});
