import { describe, expect, it } from "vitest";
import {
  compileGraph,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { ALL_NODE_CATEGORIES, createDefaultNodeRegistry, particleNodes } from "./index";

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
  it("exposes Play Particles and Stop Particles on the particles palette", () => {
    expect(ALL_NODE_CATEGORIES).toContain("particles");
    expect(particleNodes.map((entry) => entry.id)).toEqual([
      "particles.play",
      "particles.stop",
    ]);
    const registry = createDefaultNodeRegistry();
    const play = registry.get("particles.play");
    const stop = registry.get("particles.stop");
    expect(play?.category).toBe("particles");
    expect(stop?.category).toBe("particles");
    const actorPin = play?.pins({}).find((pin) => pin.name === "actor");
    expect(actorPin?.optional).toBe(true);
    expect(actorPin?.type).toEqual({ kind: "actorRef", classId: "Actor" });
  });

  it("compiled Play/Stop Particles call ctx with the actor pin or null", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "play", "particles.play"),
        node(registry, "stop", "particles.stop"),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "play",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "play",
          sourcePinId: "execOut",
          targetNodeId: "stop",
          targetPinId: "execIn",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain("ctx.playParticles");
    expect(compiled.source).toContain("ctx.stopParticles");
    const body = compiled.source.replace(
      /export\s+(async\s+)?function\s+/g,
      "$1function ",
    );
    const mod = new Function(`${body}\nreturn { onBeginPlay };`)() as {
      onBeginPlay: (ctx: unknown) => void;
    };
    const plays: unknown[] = [];
    const stops: unknown[] = [];
    mod.onBeginPlay({
      playParticles: (actor: unknown) => {
        plays.push(actor);
      },
      stopParticles: (actor: unknown) => {
        stops.push(actor);
      },
    });
    expect(plays).toEqual([null]);
    expect(stops).toEqual([null]);
  });
});
