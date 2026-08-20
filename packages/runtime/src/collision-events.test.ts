import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import {
  createActor,
  createDefaultSceneSettings,
} from "@babylonslate/core";
import type { Actor } from "@babylonslate/object-model";
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
  extra?: Partial<CompiledScript>,
): CompiledScript {
  const compiled = compileGraph(graph, { assetGuid, registry });
  return {
    assetGuid,
    classId,
    source: compiled.source,
    anchors: compiled.anchors,
    entryPoints: compiled.entryPoints,
    ...extra,
  };
}

function hitLogGraph(registry: NodeRegistry): LogicGraph {
  return {
    id: "event-graph",
    kind: "event",
    nodes: [
      node(registry, "hit", "flow.event.hit"),
      node(registry, "log", "debug.log", { category: "Hit" }),
    ],
    edges: [
      edge("e1", "hit", "execOut", "log", "execIn"),
      edge("e2", "hit", "otherActor", "log", "message"),
    ],
  };
}

function overlapLogGraph(registry: NodeRegistry): LogicGraph {
  return {
    id: "event-graph",
    kind: "event",
    nodes: [
      node(registry, "begin", "flow.event.beginOverlap"),
      node(registry, "end", "flow.event.endOverlap"),
      node(registry, "logBegin", "debug.log", { category: "OverlapBegin" }),
      node(registry, "logEnd", "debug.log", { category: "OverlapEnd" }),
    ],
    edges: [
      edge("e1", "begin", "execOut", "logBegin", "execIn"),
      edge("e2", "begin", "instigator", "logBegin", "message"),
      edge("e3", "end", "execOut", "logEnd", "execIn"),
      edge("e4", "end", "instigator", "logEnd", "message"),
    ],
  };
}

function attachKinematicBox(
  runtime: ReturnType<typeof createInProcessRuntime>,
  actor: Actor,
  isTrigger = false,
) {
  const world = runtime.getWorld();
  actor.attachComponent(
    world.createComponent({
      classId: "RigidBodyComponent",
      variables: {
        motionType: "kinematic",
        mass: 1,
        gravityScale: 0,
      },
    }),
  );
  actor.attachComponent(
    world.createComponent({
      classId: "ColliderComponent",
      variables: {
        shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
        isTrigger,
      },
    }),
  );
}

describe("runtime collision events", () => {
  it("dispatches onHit to both overlapping blocking actors", async () => {
    const registry = createDefaultNodeRegistry();
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 3,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      physicsWorld: "3d",
      dt: 1 / 60,
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      toScript(hitLogGraph(registry), registry, "Bumper", "bumper-asset"),
    ]);
    const a = runtime.spawnScriptedActor({
      classId: "Bumper",
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
    });
    const b = runtime.spawnScriptedActor({
      classId: "Bumper",
      transform: {
        position: { x: 0.4, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
    });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    attachKinematicBox(runtime, a!);
    attachKinematicBox(runtime, b!);

    runtime.start();
    runtime.tick();

    const hits = commands.filter((command) => command.type === "log" && command.category === "Hit");
    expect(hits.length).toBeGreaterThanOrEqual(2);
    runtime.stop();
  });

  it("dispatches begin then end overlap for a trigger pair", async () => {
    const registry = createDefaultNodeRegistry();
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 4,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      physicsWorld: "3d",
      dt: 1 / 60,
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      toScript(overlapLogGraph(registry), registry, "Sensor", "sensor-asset"),
    ]);
    const a = runtime.spawnScriptedActor({
      classId: "Sensor",
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
    });
    const b = runtime.spawnScriptedActor({
      classId: "Sensor",
      transform: {
        position: { x: 0.4, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
    });
    attachKinematicBox(runtime, a!);
    attachKinematicBox(runtime, b!, true);

    runtime.start();
    runtime.tick();
    const begins = commands.filter(
      (command) => command.type === "log" && command.category === "OverlapBegin",
    );
    expect(begins.length).toBeGreaterThanOrEqual(2);

    b!.transform.position.x = 10;
    runtime.tick();
    const ends = commands.filter(
      (command) => command.type === "log" && command.category === "OverlapEnd",
    );
    expect(ends.length).toBeGreaterThanOrEqual(2);
    runtime.stop();
  });

  it("skips hit dispatch when generateHitEvents is false", async () => {
    const registry = createDefaultNodeRegistry();
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 5,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      physicsWorld: "3d",
      dt: 1 / 60,
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      toScript(hitLogGraph(registry), registry, "Quiet", "quiet-asset", {
        actorDefaults: { generateHitEvents: false },
      }),
    ]);
    const a = runtime.spawnScriptedActor({
      classId: "Quiet",
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
    });
    const b = runtime.spawnScriptedActor({
      classId: "Quiet",
      transform: {
        position: { x: 0.4, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
    });
    expect(a?.generateHitEvents).toBe(false);
    expect(b?.generateHitEvents).toBe(false);
    attachKinematicBox(runtime, a!);
    attachKinematicBox(runtime, b!);
    runtime.start();
    runtime.tick();
    expect(
      commands.filter((command) => command.type === "log" && command.category === "Hit"),
    ).toHaveLength(0);
    runtime.stop();
  });

  it("skips overlap dispatch when generateOverlapEvents is false", async () => {
    const registry = createDefaultNodeRegistry();
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 6,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      physicsWorld: "3d",
      dt: 1 / 60,
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      toScript(overlapLogGraph(registry), registry, "Deaf", "deaf-asset", {
        actorDefaults: { generateOverlapEvents: false },
      }),
    ]);
    const a = runtime.spawnScriptedActor({
      classId: "Deaf",
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
    });
    const b = runtime.spawnScriptedActor({
      classId: "Deaf",
      transform: {
        position: { x: 0.4, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
    });
    expect(a?.generateOverlapEvents).toBe(false);
    expect(b?.generateOverlapEvents).toBe(false);
    attachKinematicBox(runtime, a!);
    attachKinematicBox(runtime, b!, true);
    runtime.start();
    runtime.tick();
    expect(
      commands.filter(
        (command) => command.type === "log" && command.category === "OverlapBegin",
      ),
    ).toHaveLength(0);
    runtime.stop();
  });

  it("copies actorDefaults onto scene-realized actors", async () => {
    const registry = createDefaultNodeRegistry();
    const runtime = createInProcessRuntime({
      seed: 7,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      physicsWorld: "3d",
      dt: 1 / 60,
      playScene: {
        name: "Placed",
        viewportMode: "3d",
        settings: createDefaultSceneSettings(),
        folders: [],
        actors: [createActor("placed", "Placed", { classId: "PlacedHero" })],
      },
    });
    await runtime.loadScripts([
      toScript(hitLogGraph(registry), registry, "PlacedHero", "placed-asset", {
        actorDefaults: { generateHitEvents: false, generateOverlapEvents: false },
      }),
    ]);
    runtime.realizePlayWorld();
    const placed = runtime.getWorld().findActor("placed");
    expect(placed?.classId).toBe("PlacedHero");
    expect(placed?.generateHitEvents).toBe(false);
    expect(placed?.generateOverlapEvents).toBe(false);
    runtime.stop();
  });
});
