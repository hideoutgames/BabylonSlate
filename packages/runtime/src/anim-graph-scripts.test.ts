import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import {
  animGraphScriptClassId,
  animRuleScriptClassId,
  createDefaultAnimGraph,
  createDefaultTransitionRuleGraph,
  type AnimGraphDocument,
} from "@babylonslate/anim-graph";
import {
  createActor,
  createDefaultSceneSettings,
  type SerializedScene,
} from "@babylonslate/core";
import {
  compileGraph,
  compileTransitionRuleGraph,
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
  if (!def) throw new Error(`missing node ${typeId}`);
  return {
    id,
    typeId,
    position: { x: 0, y: 0 },
    pins: def.pins(properties),
    properties,
  };
}

function animScene(
  properties: Record<string, unknown> = { graphGuid: "graph-1" },
): SerializedScene {
  return {
    name: "Anim",
    viewportMode: "3d",
    settings: createDefaultSceneSettings(),
    folders: [],
    actors: [
      createActor("hero", "Hero", {
        components: [
          {
            id: "anim-1",
            classId: "AnimationGraphComponent",
            properties,
          },
        ],
      }),
    ],
  };
}

function locoDocument(): AnimGraphDocument {
  const doc = createDefaultAnimGraph();
  doc.variables = [
    { id: "var-moving", name: "moving", typeId: "bool", defaultValue: false },
  ];
  doc.states.push({
    id: "run",
    name: "Run",
    clipId: "run-clip",
    speed: 1,
    loop: true,
    position: { x: 300, y: 80 },
  });
  doc.clips.push({
    id: "run-clip",
    kind: "sprite",
    assetGuid: "sprite-1",
    clipName: "Run",
    durationMs: 400,
  });
  doc.transitions.push({
    id: "idle-to-run",
    fromStateId: "idle",
    toStateId: "run",
    blendSeconds: 0,
    priority: 0,
    ruleGraph: createDefaultTransitionRuleGraph(),
  });
  return doc;
}

function toAnimObjectScript(
  graph: LogicGraph,
  registry: NodeRegistry,
): CompiledScript {
  const compiled = compileGraph(graph, {
    assetGuid: "assets/Loco.anim.babasset",
    registry,
  });
  return {
    assetGuid: "assets/Loco.anim.babasset",
    classId: animGraphScriptClassId("graph-1"),
    source: compiled.source,
    anchors: compiled.anchors,
    entryPoints: compiled.entryPoints,
    parentClassId: "BObject",
  };
}

function toRuleScript(
  graph: LogicGraph,
  registry: NodeRegistry,
  transitionId: string,
): CompiledScript {
  const compiled = compileTransitionRuleGraph(graph, {
    assetGuid: `assets/Loco.anim.babasset#${transitionId}`,
    registry,
  });
  return {
    assetGuid: `assets/Loco.anim.babasset#${transitionId}`,
    classId: animRuleScriptClassId("graph-1", transitionId),
    source: compiled.source,
    anchors: compiled.anchors,
    entryPoints: compiled.entryPoints,
    parentClassId: "BObject",
  };
}

function movingRuleGraph(registry: NodeRegistry): LogicGraph {
  return {
    id: "idle-to-run",
    kind: "event",
    nodes: [
      node(registry, "enter-state", "anim.rule.enterState"),
      node(registry, "exit-state", "anim.rule.exitState"),
      node(registry, "get-moving", "variables.get", {
        variableName: "moving",
        typeId: "bool",
        implicitSelf: true,
      }),
    ],
    edges: [
      {
        id: "e-exit",
        sourceNodeId: "get-moving",
        sourcePinId: "value",
        targetNodeId: "exit-state",
        targetPinId: "value",
      },
    ],
  };
}

function lastAnimState(
  commands: readonly CommandMessage[],
): Extract<CommandMessage, { type: "animState" }> | undefined {
  return [...commands].reverse().find((command) => command.type === "animState") as
    | Extract<CommandMessage, { type: "animState" }>
    | undefined;
}

describe("runtime AnimationGraph scripts", () => {
  it("keeps a compiled rule closed until Animation Object sets the variable", async () => {
    const registry = createDefaultNodeRegistry();
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
      playScene: animScene(),
      animGraphs: { "graph-1": locoDocument() },
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      toRuleScript(movingRuleGraph(registry), registry, "idle-to-run"),
    ]);
    runtime.start();
    runtime.realizePlayWorld();
    runtime.tick();
    expect(lastAnimState(commands)?.stateId).toBe("idle");
    runtime.stop();
  });

  it("runs Initialize then Update and transitions from a compiled rule", async () => {
    const registry = createDefaultNodeRegistry();
    const objectGraph: LogicGraph = {
      id: "animation-object",
      kind: "event",
      nodes: [
        node(registry, "init", "anim.event.initialize"),
        node(registry, "set-moving", "variables.set", {
          variableName: "moving",
          typeId: "bool",
          implicitSelf: true,
          moving: true,
        }),
        node(registry, "update", "anim.event.update"),
      ],
      edges: [
        {
          id: "e-init",
          sourceNodeId: "init",
          sourcePinId: "execOut",
          targetNodeId: "set-moving",
          targetPinId: "execIn",
        },
      ],
    };
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
      playScene: animScene(),
      animGraphs: { "graph-1": locoDocument() },
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      toAnimObjectScript(objectGraph, registry),
      toRuleScript(movingRuleGraph(registry), registry, "idle-to-run"),
    ]);
    runtime.start();
    runtime.realizePlayWorld();
    runtime.tick();
    const anim = lastAnimState(commands);
    expect(anim).toMatchObject({
      type: "animState",
      stateId: "run",
      clipName: "Run",
      clipKind: "sprite",
      clipAssetGuid: "sprite-1",
    });
    expect(anim?.layers?.some((layer) => layer.clipName === "Run")).toBe(true);
    runtime.stop();
  });

  it("jumps to a named state from an Actor Tick graph before evaluating the AnimGraph", async () => {
    const registry = createDefaultNodeRegistry();
    const actorGraph: LogicGraph = {
      id: "hero",
      kind: "event",
      nodes: [
        node(registry, "tick", "flow.event.tick"),
        node(registry, "jump", "anim.actor.jumpToState", { state: "Run" }),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "tick",
          sourcePinId: "execOut",
          targetNodeId: "jump",
          targetPinId: "execIn",
        },
      ],
    };
    const compiled = compileGraph(actorGraph, {
      assetGuid: "hero-class",
      registry,
    });
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
      playScene: animScene(),
      animGraphs: { "graph-1": locoDocument() },
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      {
        assetGuid: "hero-class",
        classId: "Hero",
        source: compiled.source,
        anchors: compiled.anchors,
        entryPoints: compiled.entryPoints,
        parentClassId: "Actor",
      },
    ]);
    runtime.start();
    runtime.realizePlayWorld();
    runtime.tick();
    expect(lastAnimState(commands)?.stateId).toBe("run");
    runtime.stop();
  });

  it("emits weighted layers and clipAssetGuid while blending", () => {
    const doc = createDefaultAnimGraph();
    doc.clips[0]!.assetGuid = "anim-idle";
    doc.states.push({
      id: "run",
      name: "Run",
      clipId: "run-clip",
      speed: 1,
      loop: true,
      position: { x: 300, y: 80 },
    });
    doc.clips.push({
      id: "run-clip",
      kind: "sprite",
      assetGuid: "sprite-1",
      clipName: "Run",
      durationMs: 400,
    });
    doc.transitions.push({
      id: "idle-to-run",
      fromStateId: "idle",
      toStateId: "run",
      blendSeconds: 0.2,
      priority: 0,
      condition: "moving",
      ruleGraph: createDefaultTransitionRuleGraph(),
    });
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
      playScene: animScene({
        graphGuid: "graph-1",
        conditions: { moving: true },
      }),
      animGraphs: { "graph-1": doc },
      onCommand: (command) => commands.push(command),
    });
    runtime.start();
    runtime.realizePlayWorld();
    runtime.tick();
    const anim = lastAnimState(commands);
    expect(anim?.stateId).toBe("run");
    expect(anim?.layers?.length).toBe(2);
    expect(anim?.clipAssetGuid).toBe("sprite-1");
    runtime.stop();
  });
});
