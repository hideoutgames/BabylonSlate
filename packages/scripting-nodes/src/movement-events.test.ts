import { describe, expect, it } from "vitest";
import { compileGraph, type GraphNode, type NodeRegistry } from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "./index";

function node(registry: NodeRegistry, id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode {
  const definition = registry.get(typeId);
  if (!definition) throw new Error(`Missing node ${typeId}`);
  return { id, typeId, properties, position: { x: 0, y: 0 }, pins: definition.pins(properties) };
}

describe("movement event graphs", () => {
  it.each([
    ["movementStarted", "onMovementStarted"],
    ["movementStopped", "onMovementStopped"],
    ["movementJumped", "onMovementJumped"],
    ["movementLeftGround", "onMovementLeftGround"],
    ["movementLanded", "onMovementLanded"],
  ])("compiles %s with component binding and forwards its movement state", (eventType, exportName) => {
    const registry = createDefaultNodeRegistry();
    const compiled = compileGraph({
      id: "movement-events", kind: "event",
      nodes: [
        node(registry, "event", `flow.event.${eventType}`, { componentId: "movement" }),
        node(registry, "consume", "debug.executeJavaScript", {
          inputs: [{ name: "velocity", type: "vec3" }, { name: "speed", type: "float" }],
          body: "ctx.received = { velocity, speed };",
        }),
      ],
      edges: [
        { id: "exec", sourceNodeId: "event", sourcePinId: "execOut", targetNodeId: "consume", targetPinId: "execIn" },
        { id: "velocity", sourceNodeId: "event", sourcePinId: "velocity", targetNodeId: "consume", targetPinId: "in_velocity" },
        { id: "speed", sourceNodeId: "event", sourcePinId: "speed", targetNodeId: "consume", targetPinId: "in_speed" },
      ],
    }, { registry, assetGuid: "character" });
    expect(compiled.entryPoints).toHaveLength(1);
    expect(compiled.entryPoints[0]).toMatchObject({ event: exportName, componentId: "movement" });
    const run = new Function(`${compiled.source.replace(/^export /gm, "")}\nreturn ${compiled.entryPoints[0]!.name};`)() as (context: unknown) => void;
    const context = { args: { velocity: { x: 3, y: -2, z: 4 }, speed: 5 }, received: undefined };
    run(context);
    expect(context.received).toEqual({ velocity: { x: 3, y: -2, z: 4 }, speed: 5 });
  });
});
