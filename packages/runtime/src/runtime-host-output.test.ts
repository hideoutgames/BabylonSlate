import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import { compileGraph, type GraphNode, type LogicGraph, type NodeRegistry } from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { createInProcessRuntime } from "./driver";
import { createOutputHostBindings } from "./runtime-host-output";

function node(registry: NodeRegistry, id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode {
  return { id, typeId, position: { x: 0, y: 0 }, pins: registry.get(typeId)!.pins(properties), properties };
}
const edge = (id: string, sourceNodeId: string, sourcePinId: string, targetNodeId: string, targetPinId: string) =>
  ({ id, sourceNodeId, sourcePinId, targetNodeId, targetPinId });

// The worker clones a queued command when the batch is flushed, after the pump has
// run on; these tests keep the emitted object and look at it afterwards to see what
// that clone would carry.
describe("output commands are detached from script state at emit", () => {
  it("sends a Draw Debug Line start read from Get Actor Location as it was before Set Actor Location moved the Actor", async () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "self", "actor.getSelf"),
        node(registry, "location", "transform.getLocation"),
        node(registry, "draw", "debug.drawLine"),
        node(registry, "move", "transform.setLocation", { "default:location": { x: 50, y: 0, z: 0 } }),
      ],
      edges: [
        edge("e1", "begin", "execOut", "draw", "execIn"),
        edge("e2", "draw", "execOut", "move", "execIn"),
        edge("e3", "self", "out", "location", "target"),
        edge("e4", "location", "out", "draw", "start"),
        edge("e5", "self", "out", "move", "target"),
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "painter-asset", registry });
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, onCommand: (command) => commands.push(command) });
    try {
      await runtime.loadScripts([{ assetGuid: "painter-asset", classId: "Painter", source: compiled.source,
        anchors: compiled.anchors, entryPoints: compiled.entryPoints }]);
      const actor = runtime.spawnScriptedActor({ classId: "Painter" })!;
      runtime.start();
      runtime.tick();
      expect(actor.transform.position.x).toBe(50);
      const draw = commands.find((command) => command.type === "debugDraw");
      expect(draw).toMatchObject({ kind: "line", start: { x: 0, y: 0, z: 0 } });
    } finally {
      runtime.stop();
    }
  });

  it("logs a wired empty reference as an error on every tick, anchored to the node that met it, and skips the node", async () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "tick", "flow.event.tick"),
        node(registry, "find", "actor.getOfClass", { "default:classId": "Ghost" }),
        node(registry, "destroy", "actor.destroy", { title: "Destroy Actor" }),
      ],
      edges: [
        edge("e1", "tick", "execOut", "destroy", "execIn"),
        edge("e2", "find", "out", "destroy", "target"),
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "painter-asset", registry, className: "Painter" });
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, onCommand: (command) => commands.push(command) });
    try {
      await runtime.loadScripts([{ assetGuid: "painter-asset", classId: "Painter", source: compiled.source,
        anchors: compiled.anchors, entryPoints: compiled.entryPoints }]);
      const actor = runtime.spawnScriptedActor({ classId: "Painter" })!;
      runtime.start();
      runtime.tick();
      runtime.tick();
      const message = "Painter: Destroy Actor (Target) tried to access null.";
      // Not Self: the running actor survives, and each tick reports again.
      expect(actor.destroyed).toBe(false);
      expect(commands.filter((command) => command.type === "log")).toEqual([
        expect.objectContaining({ severity: "error", category: "Script", message }),
        expect.objectContaining({ severity: "error", category: "Script", message }),
      ]);
      expect(commands.filter((command) => command.type === "diagnostic")).toEqual([
        expect.objectContaining({ message, nodeId: "destroy" }),
        expect.objectContaining({ message, nodeId: "destroy" }),
      ]);
    } finally {
      runtime.stop();
    }
  });

  it("sends a Print String color as it was when printed", () => {
    const emitted: CommandMessage[] = [];
    const bindings = createOutputHostBindings({ frameId: () => 1, tickIndex: () => 1, anchors: new Map(),
      recordDiagnostic: () => {}, recordPrint: () => {}, emit: (command) => emitted.push(command) });
    const color = { x: 1, y: 0.5, z: 0.25, w: 1 };
    bindings.print("hello", "key", 2, color);
    color.x = 0;
    expect(emitted[0]).toMatchObject({ type: "print", color: { x: 1, y: 0.5, z: 0.25, w: 1 } });
  });
});
