import { describe, expect, it } from "vitest";
import { createActor, createDefaultSceneSettings, type InputAssetDefinition } from "@babylonslate/core";
import { engineScriptApiFor } from "@babylonslate/object-model";
import { compileGraph, type GraphNode } from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { createInProcessRuntime } from "./driver";

const inputAssets: InputAssetDefinition[] = [{
  guid: "move", name: "Move", type: "InputAxis", valueType: "2d",
  bindings: [{ id: "right", device: "key", code: "KeyD", component: "x", digitalValue: 0.6 }],
}];

function movementGraph() {
  const registry = createDefaultNodeRegistry();
  const node = (id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode => ({
    id, typeId, properties, position: { x: 0, y: 0 }, pins: registry.get(typeId)!.pins(properties),
  });
  const call = (id: string, name: string) => {
    const definition = engineScriptApiFor("MovementComponent")!.functions!.find((entry) => entry.name === name)!;
    return node(id, "functions.call", {
      classId: "MovementComponent", functionName: name, runtime: definition.runtime, pins: definition.pins,
    });
  };
  const edge = (sourceNodeId: string, sourcePinId: string, targetNodeId: string, targetPinId: string) => ({
    id: `${sourceNodeId}-${sourcePinId}-${targetNodeId}-${targetPinId}`,
    sourceNodeId, sourcePinId, targetNodeId, targetPinId,
  });
  return compileGraph({
    id: "input-movement", kind: "event",
    nodes: [
      node("axis", "input.axisEvent", { valueType: "2d", "default:binding": { Input: { Name: "Move", Asset: "move" } } }),
      node("motor", "variables.get", {
        variableName: "Movement", componentId: "motor", typeId: "object", typeClassId: "MovementComponent", implicitSelf: true,
      }),
      node("heading", "variables.set", {
        variableName: "Input Yaw", propertyKey: "inputYaw", classId: "MovementComponent", typeId: "float", "default:value": 90,
      }),
      call("convert", "Convert Input"),
      call("apply", "Set Movement Input"),
      call("release", "Set Movement Input"),
    ],
    edges: [
      edge("axis", "held", "heading", "execIn"),
      edge("heading", "execOut", "convert", "exec"),
      edge("axis", "value", "convert", "input"),
      edge("convert", "then", "apply", "exec"),
      edge("convert", "direction", "apply", "direction"),
      edge("axis", "released", "release", "exec"),
      ...["heading", "convert", "apply", "release"].map((id) => edge("motor", "value", id, "target")),
    ],
  }, { assetGuid: "hero-controls", registry });
}

describe("Movement input graphs", () => {
  it.each(["3d", "2d"] as const)("converts held input and clears it on release in %s, leaving unwired actors still", async (kind) => {
    const component = {
      id: "motor", classId: "MovementComponent",
      properties: { gravityScale: 0, maxSpeed: 4, acceleration: 600, braking: 600, airControl: 1, deadZone: 0.2, inputScale: 0.5 },
    };
    const commands: string[] = [];
    const runtime = createInProcessRuntime({
      seed: 1, seedDemoActors: false, preferSoftwarePhysics: true, dt: 0.1,
      physicsWorld: kind, inputAssets, onCommand: (command) => commands.push(command.type),
      playScene: {
        name: "Graph Movement", viewportMode: kind,
        settings: { ...createDefaultSceneSettings(), physicsWorld: kind }, folders: [],
        actors: [
          createActor("hero", "Hero", { classId: "Hero", components: [
            component,
            { id: "visual", classId: "MeshComponent", properties: { meshKind: "box", collisionMode: "none" } },
          ] }),
          createActor("unwired", "Unwired", {
            transform: { position: [10, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
            components: [{ ...component, id: "unwired-motor" }],
          }),
        ],
      },
    });
    try {
      await runtime.loadScripts([{ assetGuid: "hero-controls", classId: "Hero", parentClassId: "Actor", ...movementGraph() }]);
      runtime.realizePlayWorld();
      runtime.start();
      const hero = runtime.getWorld().findActor("hero")!;
      const unwired = runtime.getWorld().findActor("unwired")!;
      runtime.tick();
      expect(hero.transform.position).toEqual({ x: 0, y: 0, z: 0 });
      commands.length = 0;
      runtime.pushInput([{ kind: "key", tick: 1, code: "KeyD", phase: "down" }]);
      for (let i = 0; i < 3; i++) runtime.tick();
      // (0.6 - 0.2) / (1 - 0.2) * 0.5 * 4 = 1 world unit/s.
      expect(hero.transform.position.x).toBeCloseTo(kind === "2d" ? 0.3 : 0);
      expect(hero.transform.position.z).toBeCloseTo(kind === "3d" ? -0.3 : 0);
      expect(unwired.transform.position).toEqual({ x: 10, y: 0, z: 0 });
      // Per-tick steering property writes must not reassign the actor's visual mesh.
      expect(commands).not.toContain("assignMesh");
      runtime.pushInput([{ kind: "key", tick: 4, code: "KeyD", phase: "up" }]);
      const releasedAt = { ...hero.transform.position };
      for (let i = 0; i < 4; i++) runtime.tick();
      expect(hero.transform.position.x).toBeCloseTo(releasedAt.x);
      expect(hero.transform.position.z).toBeCloseTo(releasedAt.z);
      expect(hero.components[0]!.getVariable("speed")).toBe(0);
    } finally {
      runtime.stop();
    }
  });
});
