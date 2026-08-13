import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import {
  compileGraph,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";

function node(
  registry: NodeRegistry,
  id: string,
  typeId: string,
  properties: Record<string, unknown> = {},
): GraphNode {
  const def = registry.get(typeId);
  if (!def) throw new Error(`missing node definition ${typeId}`);
  return {
    id,
    typeId,
    position: { x: 0, y: 0 },
    pins: def.pins(properties),
    properties,
  };
}

function edge(
  id: string,
  sourceNodeId: string,
  sourcePinId: string,
  targetNodeId: string,
  targetPinId: string,
) {
  return { id, sourceNodeId, sourcePinId, targetNodeId, targetPinId };
}

function toScript(
  graph: LogicGraph,
  registry: NodeRegistry,
  classId: string,
  assetGuid: string,
): CompiledScript {
  const compiled = compileGraph(graph, { assetGuid, registry });
  return {
    assetGuid,
    classId,
    source: compiled.source,
    anchors: compiled.anchors,
    entryPoints: compiled.entryPoints,
  };
}

describe("apply / remove UserInterface from a class graph", () => {
  it("emits uiApply on Begin Play and uiRemove when the instance is removed", async () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "apply", "ui.applyToViewport", { asset: "hud-guid" }),
        node(registry, "remove", "ui.removeFromViewport"),
      ],
      edges: [
        edge("e1", "begin", "execOut", "apply", "execIn"),
        edge("e2", "apply", "execOut", "remove", "execIn"),
        edge("e3", "apply", "instance", "remove", "instance"),
      ],
    };

    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      toScript(graph, registry, "HudHost", "hud-host-asset"),
    ]);
    runtime.spawnScriptedActor({ classId: "HudHost" });
    runtime.start();
    runtime.tick();

    const apply = commands.filter((command) => command.type === "uiApply");
    const remove = commands.filter((command) => command.type === "uiRemove");
    expect(apply).toEqual([
      { type: "uiApply", instanceId: "ui-1", assetGuid: "hud-guid" },
    ]);
    expect(remove).toEqual([{ type: "uiRemove", instanceId: "ui-1" }]);
    runtime.stop();
  });

  it("does not emit apply when the asset guid is empty", async () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "apply", "ui.applyToViewport", { asset: "  " }),
      ],
      edges: [edge("e1", "begin", "execOut", "apply", "execIn")],
    };
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      toScript(graph, registry, "EmptyHud", "empty-hud-asset"),
    ]);
    runtime.spawnScriptedActor({ classId: "EmptyHud" });
    runtime.start();
    runtime.tick();
    expect(commands.filter((command) => command.type === "uiApply")).toEqual([]);
    runtime.stop();
  });
});
