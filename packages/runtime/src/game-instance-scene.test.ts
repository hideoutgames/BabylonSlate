import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import {
  createActor,
  createDefaultSceneSettings,
  createMeshComponent,
  type SerializedScene,
} from "@babylonslate/core";
import { sceneAssetClassId } from "@babylonslate/object-model";
import {
  compileGraph,
  STRING,
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
  parentClassId?: string,
): CompiledScript {
  const compiled = compileGraph(graph, { assetGuid, registry });
  return {
    assetGuid,
    classId,
    source: compiled.source,
    anchors: compiled.anchors,
    entryPoints: compiled.entryPoints,
    ...(parentClassId ? { parentClassId } : {}),
  };
}

function logMessages(commands: readonly CommandMessage[]): string[] {
  return commands
    .filter((command) => command.type === "log")
    .map((command) => String((command as { message: string }).message));
}

function sceneNamed(
  name: string,
  actors: SerializedScene["actors"] = [],
): SerializedScene {
  return {
    name,
    viewportMode: "3d",
    settings: createDefaultSceneSettings(),
    folders: [],
    actors,
  };
}

function giLoggerGraph(registry: NodeRegistry): LogicGraph {
  const js = (id: string, body: string) =>
    node(registry, id, "debug.executeJavaScript", {
      inputs: [{ name: "tag", type: STRING }],
      outputs: [],
      body,
    });
  return {
    id: "event-graph",
    kind: "event",
    nodes: [
      node(registry, "init", "flow.event.init"),
      node(registry, "tick", "flow.event.tick"),
      node(registry, "end", "flow.event.end"),
      node(registry, "first", "flow.event.firstSceneLoaded"),
      node(registry, "startLoad", "flow.event.sceneStartLoading"),
      node(registry, "finish", "flow.event.sceneFinishLoading"),
      node(registry, "exit", "flow.event.sceneExit"),
      js("logInit", 'ctx.log("log", "Script", "init");'),
      js("logTick", 'ctx.log("log", "Script", "tick");'),
      js("logEnd", 'ctx.log("log", "Script", "end");'),
      js("logFirst", 'ctx.log("log", "Script", "first:" + tag);'),
      js("logStart", 'ctx.log("log", "Script", "start:" + tag);'),
      js(
        "logFinish",
        'ctx.log("log", "Script", "finish:" + tag + ":p" + ctx.getSceneLoadingProgress());',
      ),
      js("logExit", 'ctx.log("log", "Script", "exit:" + tag);'),
    ],
    edges: [
      edge("e-init", "init", "execOut", "logInit", "execIn"),
      edge("e-tick", "tick", "execOut", "logTick", "execIn"),
      edge("e-end", "end", "execOut", "logEnd", "execIn"),
      edge("e-first", "first", "execOut", "logFirst", "execIn"),
      edge("e-first-name", "first", "sceneName", "logFirst", "in_tag"),
      edge("e-start", "startLoad", "execOut", "logStart", "execIn"),
      edge("e-start-name", "startLoad", "sceneName", "logStart", "in_tag"),
      edge("e-finish", "finish", "execOut", "logFinish", "execIn"),
      edge("e-finish-name", "finish", "sceneName", "logFinish", "in_tag"),
      edge("e-exit", "exit", "execOut", "logExit", "execIn"),
      edge("e-exit-name", "exit", "sceneName", "logExit", "in_tag"),
    ],
  };
}

describe("Game Instance native events and scene APIs", () => {
  it("fires OnInit before first scene realize and OnTick while running", async () => {
    const registry = createDefaultNodeRegistry();
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      playScene: sceneNamed("Level1", [
        createActor("hero", "Hero", { classId: "Mover" }),
      ]),
      playSceneGuid: "scene-1",
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      toScript(giLoggerGraph(registry), registry, "GameInstance", "gi", "GameInstance"),
      toScript(
        {
          id: "event-graph",
          kind: "event",
          nodes: [
            node(registry, "begin", "flow.event.beginPlay"),
            node(registry, "log", "debug.log", { message: "begin-play" }),
          ],
          edges: [edge("e1", "begin", "execOut", "log", "execIn")],
        },
        registry,
        "Mover",
        "mover",
        "Actor",
      ),
    ]);
    runtime.realizePlayWorld();
    const afterRealize = logMessages(commands);
    expect(afterRealize.indexOf("init")).toBeGreaterThanOrEqual(0);
    expect(afterRealize.indexOf("init")).toBeLessThan(
      afterRealize.indexOf("start:Level1"),
    );
    expect(afterRealize.indexOf("start:Level1")).toBeLessThan(
      afterRealize.indexOf("begin-play"),
    );
    expect(afterRealize.indexOf("begin-play")).toBeLessThan(
      afterRealize.findIndex((message) => message.startsWith("finish:Level1")),
    );
    expect(afterRealize.some((message) => message === "first:Level1")).toBe(
      true,
    );
    expect(afterRealize).not.toContain("end");
    runtime.start();
    runtime.start();
    runtime.tick();
    expect(logMessages(commands).filter((message) => message === "init")).toHaveLength(
      1,
    );
    expect(logMessages(commands)).toContain("tick");
    runtime.stop();
  });

  it("never fires OnEnd on changeScene and fires OnEnd on stop after OnSceneExit", async () => {
    const registry = createDefaultNodeRegistry();
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      playScene: sceneNamed("Level1", [createActor("hero", "Hero")]),
      playSceneGuid: "scene-1",
      sceneLibrary: {
        "scene-2": sceneNamed("Level2", [createActor("other", "Other")]),
      },
      sceneGuidByKey: { "scene-2": "scene-2", Level2: "scene-2" },
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      toScript(giLoggerGraph(registry), registry, "GameInstance", "gi", "GameInstance"),
    ]);
    runtime.realizePlayWorld();
    runtime.start();
    runtime.executeConsoleCommand("changescene Level2");
    const afterChange = logMessages(commands);
    expect(afterChange).toContain("exit:Level1");
    expect(afterChange).toContain("start:Level2");
    expect(afterChange.some((message) => message.startsWith("finish:Level2"))).toBe(
      true,
    );
    expect(afterChange.filter((message) => message === "first:Level1")).toHaveLength(
      1,
    );
    expect(afterChange.some((message) => message.startsWith("first:Level2"))).toBe(
      false,
    );
    expect(afterChange).not.toContain("end");
    runtime.stop();
    const afterStop = logMessages(commands);
    expect(afterStop.filter((message) => message === "end")).toHaveLength(1);
    expect(afterStop.lastIndexOf("exit:Level2")).toBeLessThan(
      afterStop.lastIndexOf("end"),
    );
  });

  it("does not finish-load a missing changeScene key", async () => {
    const registry = createDefaultNodeRegistry();
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      playScene: sceneNamed("Level1"),
      playSceneGuid: "scene-1",
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      toScript(giLoggerGraph(registry), registry, "GameInstance", "gi", "GameInstance"),
    ]);
    runtime.realizePlayWorld();
    const before = logMessages(commands).filter((message) =>
      message.startsWith("finish:"),
    ).length;
    runtime.executeConsoleCommand("changescene missing-level");
    expect(
      commands.some(
        (command) =>
          command.type === "log" &&
          String((command as { message: string }).message).includes(
            "missing-level",
          ),
      ),
    ).toBe(true);
    expect(
      logMessages(commands).filter((message) => message.startsWith("finish:"))
        .length,
    ).toBe(before);
    expect(logMessages(commands)).not.toContain("end");
    runtime.stop();
  });

  it("reports progress 0 at start loading and 1 after finish", async () => {
    const registry = createDefaultNodeRegistry();
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      playScene: sceneNamed("Level1", [createActor("hero", "Hero")]),
      playSceneGuid: "scene-1",
      onCommand: (command) => commands.push(command),
    });
    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "startLoad", "flow.event.sceneStartLoading"),
        node(registry, "finish", "flow.event.sceneFinishLoading"),
        node(registry, "logStart", "debug.executeJavaScript", {
          inputs: [],
          outputs: [],
          body: 'ctx.log("log", "Script", "p-start:" + ctx.getSceneLoadingProgress());',
        }),
        node(registry, "logFinish", "debug.executeJavaScript", {
          inputs: [],
          outputs: [],
          body: 'ctx.log("log", "Script", "p-finish:" + ctx.getSceneLoadingProgress());',
        }),
      ],
      edges: [
        edge("e1", "startLoad", "execOut", "logStart", "execIn"),
        edge("e2", "finish", "execOut", "logFinish", "execIn"),
      ],
    };
    await runtime.loadScripts([
      toScript(graph, registry, "GameInstance", "gi", "GameInstance"),
    ]);
    runtime.realizePlayWorld();
    const messages = logMessages(commands);
    expect(messages).toContain("p-start:0");
    expect(messages).toContain("p-finish:1");
    runtime.stop();
  });

  it("returns a live Scene reference that is null after swap and OnEnd", async () => {
    const registry = createDefaultNodeRegistry();
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      playScene: sceneNamed("Level1", [createActor("hero", "Hero")]),
      playSceneGuid: "scene-1",
      sceneLibrary: {
        "scene-2": sceneNamed("Level2", [createActor("other", "Other")]),
      },
      sceneGuidByKey: { "scene-2": "scene-2", Level2: "scene-2" },
      onCommand: (command) => commands.push(command),
    });
    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "finish", "flow.event.sceneFinishLoading"),
        node(registry, "exit", "flow.event.sceneExit"),
        node(registry, "end", "flow.event.end"),
        node(registry, "logFinish", "debug.executeJavaScript", {
          inputs: [],
          outputs: [],
          body: 'const scene = ctx.getSceneReference(); ctx.log("log", "Script", "ref-finish:" + (scene && scene.getVariable("sceneName")));',
        }),
        node(registry, "logExit", "debug.executeJavaScript", {
          inputs: [],
          outputs: [],
          body: 'ctx.log("log", "Script", "ref-exit:" + (ctx.getSceneReference() == null));',
        }),
        node(registry, "logEnd", "debug.executeJavaScript", {
          inputs: [],
          outputs: [],
          body: 'ctx.log("log", "Script", "ref-end:" + (ctx.getSceneReference() == null));',
        }),
      ],
      edges: [
        edge("e1", "finish", "execOut", "logFinish", "execIn"),
        edge("e2", "exit", "execOut", "logExit", "execIn"),
        edge("e3", "end", "execOut", "logEnd", "execIn"),
      ],
    };
    await runtime.loadScripts([
      toScript(graph, registry, "GameInstance", "gi", "GameInstance"),
    ]);
    runtime.realizePlayWorld();
    const first = runtime.getWorld().currentScene;
    expect(first?.classId).toBe(sceneAssetClassId("scene-1"));
    expect(first?.getVariable("sceneName")).toBe("Level1");
    expect(logMessages(commands)).toContain("ref-finish:Level1");
    runtime.executeConsoleCommand("changescene Level2");
    expect(first?.destroyed).toBe(true);
    expect(runtime.getWorld().currentScene?.classId).toBe(
      sceneAssetClassId("scene-2"),
    );
    expect(logMessages(commands)).toContain("ref-exit:true");
    expect(logMessages(commands)).toContain("ref-finish:Level2");
    runtime.stop();
    expect(runtime.getWorld().currentScene).toBeNull();
    expect(logMessages(commands)).toContain("ref-end:true");
  });

  it("casts to Scene:{guid} only for the active scene and gets placed components", async () => {
    const registry = createDefaultNodeRegistry();
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      playScene: sceneNamed("Level1", [
        createActor("hero", "Hero", {
          components: [createMeshComponent("mesh-hero", "box")],
        }),
      ]),
      playSceneGuid: "scene-1",
      sceneLibrary: {
        "scene-2": sceneNamed("Level2", [createActor("other", "Other")]),
      },
      sceneGuidByKey: { "scene-2": "scene-2", Level2: "scene-2" },
      onCommand: (command) => commands.push(command),
    });
    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "finish", "flow.event.sceneFinishLoading"),
        node(registry, "logCast", "debug.executeJavaScript", {
          inputs: [],
          outputs: [],
          body: [
            "const scene = ctx.getSceneReference();",
            `const selfOk = ctx.isA(scene, ${JSON.stringify(sceneAssetClassId("scene-1"))});`,
            `const otherOk = ctx.isA(scene, ${JSON.stringify(sceneAssetClassId("scene-2"))});`,
            'const mesh = ctx.getComponentById(scene, "mesh-hero");',
            'ctx.log("log", "Script", "cast:" + selfOk + ":" + otherOk + ":mesh:" + (mesh != null));',
          ].join("\n"),
        }),
      ],
      edges: [edge("e1", "finish", "execOut", "logCast", "execIn")],
    };
    await runtime.loadScripts([
      toScript(graph, registry, "GameInstance", "gi", "GameInstance"),
    ]);
    runtime.realizePlayWorld();
    expect(logMessages(commands)).toContain("cast:true:false:mesh:true");
    runtime.executeConsoleCommand("changescene Level2");
    expect(logMessages(commands)).toContain("cast:false:true:mesh:false");
    runtime.stop();
  });

  it("keeps GI ticks running until sceneModelsReady when load is deferred", async () => {
    const registry = createDefaultNodeRegistry();
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      deferSceneModelsReady: true,
      playScene: sceneNamed("Level1", [createActor("hero", "Hero")]),
      playSceneGuid: "scene-1",
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      toScript(giLoggerGraph(registry), registry, "GameInstance", "gi", "GameInstance"),
    ]);
    runtime.realizePlayWorld();
    expect(
      logMessages(commands).some((message) => message.startsWith("finish:")),
    ).toBe(false);
    runtime.start();
    runtime.tick();
    expect(logMessages(commands)).toContain("tick");
    expect(
      logMessages(commands).some((message) => message.startsWith("finish:")),
    ).toBe(false);
    runtime.notifySceneModelsReady("scene-1");
    expect(
      logMessages(commands).some((message) => message.startsWith("finish:Level1")),
    ).toBe(true);
    expect(logMessages(commands)).toContain("first:Level1");
    runtime.stop();
  });

  it("fires OnSceneExit then OnEnd when Play stops before sceneModelsReady", async () => {
    const registry = createDefaultNodeRegistry();
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      deferSceneModelsReady: true,
      playScene: sceneNamed("Level1", [createActor("hero", "Hero")]),
      playSceneGuid: "scene-1",
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      toScript(giLoggerGraph(registry), registry, "GameInstance", "gi", "GameInstance"),
    ]);
    runtime.realizePlayWorld();
    expect(
      logMessages(commands).some((message) => message.startsWith("finish:")),
    ).toBe(false);
    runtime.stop();
    const messages = logMessages(commands);
    expect(messages).toContain("exit:Level1");
    expect(messages).toContain("end");
    expect(messages.indexOf("exit:Level1")).toBeLessThan(messages.indexOf("end"));
    expect(messages.some((message) => message.startsWith("finish:"))).toBe(false);
  });

  it("Gets Scene Asset Guid and Get/Sets Gravity on a live Scene reference", async () => {
    const registry = createDefaultNodeRegistry();
    const commands: CommandMessage[] = [];
    const settings = createDefaultSceneSettings();
    settings.gravity = [0, -4, 0];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      gravity: [0, -4, 0],
      playScene: {
        name: "Level1",
        viewportMode: "3d",
        settings,
        folders: [],
        actors: [
          createActor("ball", "Ball", {
            transform: {
              position: [0, 0, 0],
              rotation: [0, 0, 0, 1],
              scale: [1, 1, 1],
            },
            components: [
              {
                id: "rb-ball",
                classId: "RigidBodyComponent",
                properties: { motionType: "dynamic", mass: 1, gravityScale: 1 },
              },
              {
                id: "col-ball",
                classId: "ColliderComponent",
                properties: {
                  shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
                },
              },
            ],
          }),
        ],
      },
      playSceneGuid: "scene-1",
      onCommand: (command) => commands.push(command),
    });
    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "finish", "flow.event.sceneFinishLoading"),
        node(registry, "log", "debug.executeJavaScript", {
          inputs: [],
          outputs: [],
          body: [
            "const scene = ctx.getSceneReference();",
            'const guid = ctx.getVariableFrom(scene, "assetGuid");',
            'const before = ctx.getVariableFrom(scene, "gravity");',
            'ctx.setVariableOn(scene, "gravity", { x: 0, y: 12, z: 0 });',
            'const after = ctx.getVariableFrom(scene, "gravity");',
            'ctx.log("log", "Script", "guid:" + guid);',
            'ctx.log("log", "Script", "g0:" + (before && before.y));',
            'ctx.log("log", "Script", "g1:" + (after && after.y));',
          ].join("\n"),
        }),
      ],
      edges: [edge("e1", "finish", "execOut", "log", "execIn")],
    };
    await runtime.loadScripts([
      toScript(graph, registry, "GameInstance", "gi", "GameInstance"),
    ]);
    runtime.realizePlayWorld();
    expect(logMessages(commands)).toEqual(
      expect.arrayContaining(["guid:scene-1", "g0:-4", "g1:12"]),
    );
    const ball = runtime.getWorld().findActor("ball");
    expect(ball).toBeTruthy();
    runtime.start();
    for (let i = 0; i < 45; i++) runtime.tick();
    expect(ball!.transform.position.y).toBeGreaterThan(0);
    runtime.stop();
  });

  it("ignores sceneModelsReady after Play stop so finish cannot run after OnEnd", async () => {
    const registry = createDefaultNodeRegistry();
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      deferSceneModelsReady: true,
      playScene: sceneNamed("Level1", [createActor("hero", "Hero")]),
      playSceneGuid: "scene-1",
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      toScript(giLoggerGraph(registry), registry, "GameInstance", "gi", "GameInstance"),
    ]);
    runtime.realizePlayWorld();
    runtime.stop();
    runtime.notifySceneModelsReady("scene-1");
    const messages = logMessages(commands);
    expect(messages).toContain("exit:Level1");
    expect(messages).toContain("end");
    expect(messages.some((message) => message.startsWith("finish:"))).toBe(false);
    expect(messages.filter((message) => message === "end")).toHaveLength(1);
  });

  it("fires OnSceneExit then starts the next load when changeScene runs before sceneModelsReady", async () => {
    const registry = createDefaultNodeRegistry();
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      deferSceneModelsReady: true,
      playScene: sceneNamed("Level1", [createActor("hero", "Hero")]),
      playSceneGuid: "scene-1",
      sceneLibrary: {
        "scene-2": sceneNamed("Level2", [createActor("other", "Other")]),
      },
      sceneGuidByKey: { "scene-2": "scene-2", Level2: "scene-2" },
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      toScript(giLoggerGraph(registry), registry, "GameInstance", "gi", "GameInstance"),
    ]);
    runtime.realizePlayWorld();
    runtime.executeConsoleCommand("changescene Level2");
    const afterChange = logMessages(commands);
    expect(afterChange).toContain("exit:Level1");
    expect(afterChange).toContain("start:Level2");
    expect(afterChange).not.toContain("end");
    expect(afterChange.some((message) => message.startsWith("finish:"))).toBe(
      false,
    );
    runtime.notifySceneModelsReady("scene-1");
    expect(
      logMessages(commands).some((message) => message.startsWith("finish:")),
    ).toBe(false);
    runtime.notifySceneModelsReady("scene-2");
    expect(logMessages(commands)).toContainEqual(
      expect.stringMatching(/^finish:Level2/),
    );
    expect(logMessages(commands)).not.toContain("end");
    runtime.stop();
    const afterStop = logMessages(commands);
    expect(afterStop).toContain("exit:Level2");
    expect(afterStop.lastIndexOf("exit:Level2")).toBeLessThan(
      afterStop.lastIndexOf("end"),
    );
  });

  it("applies the destination scene gravity when changeScene swaps worlds", async () => {
    const registry = createDefaultNodeRegistry();
    const commands: CommandMessage[] = [];
    const level1 = sceneNamed("Level1");
    level1.settings.gravity = [0, -4, 0];
    const level2 = sceneNamed("Level2");
    level2.settings.gravity = [0, 8, 0];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      gravity: [0, -4, 0],
      playScene: level1,
      playSceneGuid: "scene-1",
      sceneLibrary: { "scene-2": level2 },
      sceneGuidByKey: { "scene-2": "scene-2", Level2: "scene-2" },
      onCommand: (command) => commands.push(command),
    });
    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "finish", "flow.event.sceneFinishLoading"),
        node(registry, "log", "debug.executeJavaScript", {
          inputs: [],
          outputs: [],
          body: [
            "const scene = ctx.getSceneReference();",
            'const g = ctx.getVariableFrom(scene, "gravity");',
            'ctx.log("log", "Script", "g:" + (g && g.y) + ":" + ctx.getVariableFrom(scene, "assetGuid"));',
          ].join("\n"),
        }),
      ],
      edges: [edge("e1", "finish", "execOut", "log", "execIn")],
    };
    await runtime.loadScripts([
      toScript(graph, registry, "GameInstance", "gi", "GameInstance"),
    ]);
    runtime.realizePlayWorld();
    expect(logMessages(commands)).toContain("g:-4:scene-1");
    runtime.executeConsoleCommand("changescene Level2");
    expect(logMessages(commands)).toContain("g:8:scene-2");
    runtime.stop();
  });
});
