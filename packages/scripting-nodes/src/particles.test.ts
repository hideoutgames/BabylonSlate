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
  it("exposes Play Particles and Stop Particles on the particles palette", () => {
    expect(particleNodes.map((entry) => entry.id)).toEqual([
      "particles.play",
      "particles.stop",
      "particles.restart",
      "particles.isPlaying",
      "particles.spawnAtLocation",
      "particles.spawnAttached",
      "particles.emitBurst",
    ]);
    const registry = createDefaultNodeRegistry();
    const play = registry.get("particles.play");
    const stop = registry.get("particles.stop");
    expect(play?.category).toBe("particles");
    expect(stop?.category).toBe("particles");
    const actorPin = play?.pins({}).find((pin) => pin.name === "actor");
    expect(actorPin?.optional).toBe(true);
    expect(actorPin?.type).toEqual({ kind: "objectRef", classId: "Actor" });
  });

  it("compiled Play/Stop Particles act on Self when the actor pin is unwired", () => {
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
    const self = { guid: "self" };
    mod.onBeginPlay({
      self,
      playParticles: (actor: unknown) => {
        plays.push(actor);
      },
      stopParticles: (actor: unknown) => {
        stops.push(actor);
      },
    });
    expect(plays).toEqual([self]);
    expect(stops).toEqual([self]);
  });

  it("Is Particles Playing reads Self when the actor pin is unwired, and the wired actor otherwise", () => {
    const registry = createDefaultNodeRegistry();
    const graph = (wired: boolean): LogicGraph => ({
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "other", "actor.getOfClass"),
        node(registry, "playing", "particles.isPlaying"),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "log", targetPinId: "execIn" },
        { id: "e2", sourceNodeId: "playing", sourcePinId: "out", targetNodeId: "log", targetPinId: "message" },
        ...(wired ? [{ id: "e3", sourceNodeId: "other", sourcePinId: "out", targetNodeId: "playing", targetPinId: "actor" }] : []),
      ],
    });
    const self = { guid: "self" };
    const other = { guid: "other" };
    for (const [wired, expected] of [[false, self], [true, other]] as const) {
      const body = compileGraph(graph(wired), { assetGuid: "a", registry }).source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
      const mod = new Function(`${body}\nreturn { onBeginPlay };`)() as { onBeginPlay: (ctx: unknown) => void };
      const asked: unknown[] = [];
      const logged: unknown[] = [];
      mod.onBeginPlay({
        self,
        getActorOfClass: () => other,
        formatValue: (value: unknown) => value,
        isParticlesPlaying: (actor: unknown) => { asked.push(actor); return actor === other; },
        log: (_severity: string, _category: string, value: unknown) => logged.push(value),
      });
      expect(asked).toEqual([expected]);
      expect(logged).toEqual([expected === other]);
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

  it("Restart Particles restarts Self when the actor pin is unwired", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [node(registry, "begin", "flow.event.beginPlay"), node(registry, "restart", "particles.restart")],
      edges: [{ id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "restart", targetPinId: "execIn" }],
    };
    const body = compileGraph(graph, { assetGuid: "a", registry }).source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
    const mod = new Function(`${body}\nreturn { onBeginPlay };`)() as { onBeginPlay: (ctx: unknown) => void };
    const self = { guid: "self" };
    const restarted: unknown[] = [];
    mod.onBeginPlay({ self, restartParticles: (actor: unknown) => restarted.push(actor) });
    expect(restarted).toEqual([self]);
  });

  it("Emit Particle Burst bursts Self with Count 10 on every slot unless its pins say otherwise", () => {
    const registry = createDefaultNodeRegistry();
    const graph = (properties: Record<string, unknown>): LogicGraph => ({
      id: "g",
      kind: "event",
      nodes: [node(registry, "begin", "flow.event.beginPlay"), node(registry, "burst", "particles.emitBurst", properties)],
      edges: [{ id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "burst", targetPinId: "execIn" }],
    });
    const self = { guid: "self" };
    const calls: unknown[][] = [];
    for (const properties of [{}, { "default:count": 3, "default:slot": 1 }]) {
      const body = compileGraph(graph(properties), { assetGuid: "a", registry }).source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
      const mod = new Function(`${body}\nreturn { onBeginPlay };`)() as { onBeginPlay: (ctx: unknown) => void };
      mod.onBeginPlay({ self, emitParticleBurst: (...args: unknown[]) => calls.push(args) });
    }
    expect(calls).toEqual([[self, 10, -1], [self, 3, 1]]);
  });
});
