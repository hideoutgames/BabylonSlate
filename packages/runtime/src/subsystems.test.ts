import { describe, expect, it, vi } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import {
  createActor,
  createDefaultScene,
  createDefaultSceneLayer,
  createDefaultSceneSettings,
  type SerializedScene,
} from "@babylonslate/core";
import {
  compileGraph,
  type GraphNode,
  type LogicGraph,
} from "@babylonslate/scripting";
import {
  createDefaultNodeRegistry,
  SUBSYSTEM_GET_NODE_ID,
  subsystemGetProperties,
} from "@babylonslate/scripting-nodes";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";

const registry = createDefaultNodeRegistry();

function node(id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode {
  const def = registry.get(typeId);
  if (!def) throw new Error(`missing node definition ${typeId}`);
  return { id, typeId, position: { x: 0, y: 0 }, pins: def.pins(properties), properties };
}

/**
 * JavaScript run by an event node. The event's data pins, and one `Get
 * <Subsystem>` node per `gets` entry, are in scope under their pin/entry names.
 */
type Handler = string | { body: string; gets: Record<string, string> };

/** Compiles a real Class Graph: each event node drives one Execute JavaScript node. */
function classScript(
  classId: string,
  parentClassId: string,
  handlers: Record<string, Handler>,
  extra: { functions?: string; variables?: CompiledScript["variables"] } = {},
): CompiledScript {
  const nodes: GraphNode[] = [];
  const edges: LogicGraph["edges"] = [];
  Object.entries(handlers).forEach(([typeId, handler], index) => {
    const { body, gets = {} } = typeof handler === "string" ? { body: handler } : handler;
    const event = node(`event${index}`, typeId);
    const data = event.pins.filter((pin) => pin.direction === "out" && pin.kind === "data");
    const getNodes = Object.entries(gets).map(([name, getClassId]) => ({
      name,
      get: node(`get${index}_${name}`, SUBSYSTEM_GET_NODE_ID, subsystemGetProperties(getClassId)),
    }));
    const js = node(`js${index}`, "debug.executeJavaScript", {
      inputs: [
        ...data.map((pin) => ({ name: pin.id, type: pin.type })),
        ...getNodes.map(({ name, get }) => ({ name, type: get.pins[0]!.type })),
      ],
      outputs: [],
      body: `const log = (message) => ctx.log("log", "Script", message);\n${body}`,
    });
    nodes.push(event, js, ...getNodes.map(({ get }) => get));
    edges.push({ id: `exec${index}`, sourceNodeId: event.id, sourcePinId: "execOut", targetNodeId: js.id, targetPinId: "execIn" });
    for (const pin of data) {
      edges.push({ id: `data${index}_${pin.id}`, sourceNodeId: event.id, sourcePinId: pin.id, targetNodeId: js.id, targetPinId: `in_${pin.id}` });
    }
    for (const { name, get } of getNodes) {
      edges.push({ id: `get${index}_${name}`, sourceNodeId: get.id, sourcePinId: "subsystem", targetNodeId: js.id, targetPinId: `in_${name}` });
    }
  });
  const assetGuid = `${classId}-class`;
  const compiled = compileGraph({ id: "event-graph", kind: "event", nodes, edges }, { assetGuid, registry });
  return {
    assetGuid,
    classId,
    parentClassId,
    source: `${compiled.source}\n${extra.functions ?? ""}`,
    anchors: compiled.anchors,
    entryPoints: compiled.entryPoints,
    ...(extra.variables ? { variables: extra.variables } : {}),
  };
}

function sceneNamed(name: string, actors: SerializedScene["actors"] = []): SerializedScene {
  return { name, viewportMode: "3d", settings: createDefaultSceneSettings(), folders: [], actors };
}

/** Script log lines since the previous call. */
function scriptLog(commands: readonly CommandMessage[]): () => string[] {
  let read = 0;
  return () => {
    const lines = commands.slice(read).flatMap((command) =>
      command.type === "log" && command.category === "Script" ? [command.message] : []);
    read = commands.length;
    return lines;
  };
}

function scriptErrors(commands: readonly CommandMessage[]): string[] {
  return commands.flatMap((command) => command.type === "diagnostic" ? [command.message] : []);
}

const mover = classScript("Mover", "Actor", { "flow.event.beginPlay": 'log("begin:" + ctx.self.guid);' });

/** GameSubsystem logging every Game Instance parity event as `<tag>:<event>`. */
function gameSubsystem(classId: string, tag: string, end: string, extra: Record<string, Handler> = {}): CompiledScript {
  return classScript(classId, "GameSubsystem", {
    "flow.event.init": `log("${tag}:init");`,
    "flow.event.tick": `log("${tag}:tick");`,
    "flow.event.sceneStartLoading": `log("${tag}:start:" + sceneName + ":" + ctx.getSceneLoadingProgress());`,
    "flow.event.sceneFinishLoading": `log("${tag}:finish:" + sceneName);`,
    "flow.event.firstSceneLoaded": `log("${tag}:first:" + sceneName);`,
    "flow.event.sceneExit": `log("${tag}:exit:" + sceneName);`,
    "flow.event.end": end,
    ...extra,
  }, {
    functions: `export function Describe(ctx) { return { text: "${tag}#" + ctx.getVariable("slot") }; }`,
    variables: [{ name: "slot", type: "int", defaultValue: 3 }],
  });
}

/** SceneSubsystem logging every Scene Subsystem event; `Describe` reads Get Scene Reference. */
const weather = classScript("WeatherSubsystem", "SceneSubsystem", {
  "flow.event.init": 'log("weather:init:" + ctx.self.guid);',
  "flow.event.tick": 'log("weather:tick");',
  "flow.event.end": 'log("weather:end:" + ctx.self.guid + ":" + ctx.invokeFunction(ctx.self, "Describe", {}).text);',
  "flow.event.sceneLoaded": 'log("weather:loaded:" + sceneName);',
  "flow.event.sceneActorSpawned": 'log("weather:spawned:" + actor.guid);',
  "flow.event.sceneActorDestroyed": 'log("weather:destroyed:" + actor.guid);',
  "flow.event.streamedSceneLoaded": 'log("weather:streamLoaded:" + streamingActor.guid + ":" + scene.getVariable("sceneName"));',
  "flow.event.streamedSceneUnloaded": 'log("weather:streamUnloaded:" + streamingActor.guid + ":" + scene.getVariable("sceneName"));',
  "flow.event.sceneLayerAdded": 'log("weather:layerAdded:" + sceneLayer.guid);',
  "flow.event.sceneLayerRemoved": 'log("weather:layerRemoved:" + sceneLayer.guid);',
}, {
  functions: `export function Describe(ctx) {
    const scene = ctx.getSceneReference();
    return { text: "weather@" + (scene && scene.getVariable("sceneName")) };
  }`,
});

describe("Game Subsystems", () => {
  it("wrap the Game Instance lifecycle through Play, Change Scene and Stop", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      playScene: sceneNamed("Level1"), playSceneGuid: "scene-1",
      sceneLibrary: { "scene-2": sceneNamed("Level2") },
      sceneGuidByKey: { "scene-2": "scene-2", Level2: "scene-2" },
      onCommand: (command) => commands.push(command),
    });
    const take = scriptLog(commands);
    const gameInstance = classScript("GameInstance", "GameInstance", {
      "flow.event.init": { gets: { save: "SaveSubsystem" }, body: 'log("gi:init:" + ctx.invokeFunction(save, "Describe", {}).text);' },
      "flow.event.tick": 'log("gi:tick");',
      "flow.event.sceneStartLoading": 'log("gi:start:" + sceneName);',
      "flow.event.sceneFinishLoading": 'log("gi:finish:" + sceneName);',
      "flow.event.firstSceneLoaded": 'log("gi:first:" + sceneName);',
      "flow.event.sceneExit": 'log("gi:exit:" + sceneName);',
      "flow.event.end": { gets: { save: "SaveSubsystem" }, body: 'log("gi:end:" + ctx.invokeFunction(save, "Describe", {}).text);' },
    });
    // Out of class-id order on purpose: lifecycle order is AudioSubsystem, SaveSubsystem.
    await runtime.loadScripts([
      gameSubsystem("SaveSubsystem", "save", 'log("save:end:" + ctx.invokeFunction(ctx.self, "Describe", {}).text);'),
      gameInstance,
      gameSubsystem("AudioSubsystem", "audio", 'log("audio:end");', {
        "flow.event.scalabilityChanged": 'log("audio:scalability");',
      }),
    ]);
    try {
      runtime.realizePlayWorld();
      expect(take()).toEqual([
        "audio:init", "save:init", "gi:init:save#3",
        "gi:start:Level1", "audio:start:Level1:0", "save:start:Level1:0",
        "gi:finish:Level1", "audio:finish:Level1", "save:finish:Level1",
        "gi:first:Level1", "audio:first:Level1", "save:first:Level1",
      ]);
      runtime.start();
      runtime.tick();
      expect(take()).toEqual(["gi:tick", "audio:tick", "save:tick"]);
      const scalability = runtime.getScalability();
      runtime.applyScalabilityStatus({
        revision: scalability.result.revision, status: "applied", message: "Ready", effective: scalability.requested,
      });
      expect(take()).toEqual(["audio:scalability"]);
      runtime.executeConsoleCommand("changescene Level2");
      expect(take()).toEqual([
        "gi:exit:Level1", "audio:exit:Level1", "save:exit:Level1",
        "gi:start:Level2", "audio:start:Level2:0", "save:start:Level2:0",
        "gi:finish:Level2", "audio:finish:Level2", "save:finish:Level2",
      ]);
      runtime.stop();
      // The Game Instance's On End still reaches a GameSubsystem, which Ends after it.
      expect(take()).toEqual([
        "gi:exit:Level2", "audio:exit:Level2", "save:exit:Level2",
        "gi:end:save#3", "save:end:save#3", "audio:end",
      ]);
      expect(scriptErrors(commands)).toEqual([]);
    } finally { runtime.stop(); }
  });

  it("instantiate only leaf classes, including a user class the runtime pre-registered", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      playScene: sceneNamed("Level1"), playSceneGuid: "scene-1",
      onCommand: (command) => commands.push(command),
    });
    const take = scriptLog(commands);
    // The runtime always registers a demo `Enemy : Actor`; this project's Enemy
    // is a GameSubsystem leaf that inherits its base's On Init and function.
    await runtime.loadScripts([
      classScript("Enemy", "InventoryBase", {}),
      classScript("InventoryBase", "GameSubsystem", { "flow.event.init": 'log("init:" + ctx.self.classId);' }, {
        functions: 'export function Describe(ctx) { return { text: "inventory@" + ctx.self.classId }; }',
      }),
      classScript("GameInstance", "GameInstance", {
        "flow.event.init": {
          gets: { inventory: "InventoryBase" },
          body: 'log("gi:init:" + inventory.guid + ":" + ctx.invokeFunction(inventory, "Describe", {}).text);',
        },
      }),
    ]);
    try {
      runtime.realizePlayWorld();
      expect(take()).toEqual(["init:Enemy", "gi:init:subsystem:Enemy:inventory@Enemy"]);
      expect(runtime.spawnScriptedActor({ classId: "Enemy" })).toBeNull();
      expect(scriptErrors(commands)).toEqual([]);
    } finally { runtime.stop(); }
  });

  it("reports GameSubsystems whose scripts load after the World started instead of starting them late", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      onCommand: (command) => commands.push(command) });
    try {
      runtime.start();
      await runtime.loadScripts([classScript("LateSubsystem", "GameSubsystem", { "flow.event.init": 'log("late:init");' })]);
      runtime.tick();
      expect(runtime.getWorld().getGameSubsystems()).toEqual([]);
      expect(scriptLog(commands)()).toEqual([]);
      expect(commands.filter((command) => command.type === "log" && command.severity === "warning" &&
        command.message.includes("LateSubsystem"))).toHaveLength(1);
    } finally { runtime.stop(); }
  });
});

describe("Scene Subsystems", () => {
  it("live with each main Scene: callable while it prepares, Init before Begin Play, End before Scene Exit", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1, seedDemoActors: false, preferSoftwarePhysics: true, deferSceneModelsReady: true,
      playScene: sceneNamed("Level1", [createActor("a1", "A1", { classId: "Mover" }), createActor("a2", "A2", { classId: "Mover" })]),
      playSceneGuid: "scene-1",
      sceneLibrary: { "scene-2": sceneNamed("Level2", [createActor("b1", "B1", { classId: "Mover" })]) },
      sceneGuidByKey: { "scene-2": "scene-2", Level2: "scene-2" },
      onCommand: (command) => commands.push(command),
    });
    const take = scriptLog(commands);
    await runtime.loadScripts([
      mover,
      weather,
      classScript("GameInstance", "GameInstance", {
        "flow.event.tick": {
          gets: { weather: "WeatherSubsystem" },
          body: 'log("gi:tick:" + (weather ? ctx.invokeFunction(weather, "Describe", {}).text : "none"));',
        },
        "flow.event.sceneFinishLoading": 'log("gi:finish:" + sceneName);',
        "flow.event.sceneExit": { gets: { weather: "WeatherSubsystem" }, body: 'log("gi:exit:" + sceneName + ":" + weather);' },
      }),
    ]);
    const world = runtime.getWorld();
    try {
      runtime.realizePlayWorld();
      runtime.start();
      runtime.tick();
      // Level1 waits for its models: the Game Instance already reaches the subsystem.
      expect(take()).toEqual(["gi:tick:weather@Level1"]);
      runtime.notifySceneModelsReady("scene-1", 1);
      expect(take()).toEqual([
        "weather:init:scene-subsystem:WeatherSubsystem:1",
        "weather:spawned:a1", "begin:a1",
        "weather:spawned:a2", "begin:a2",
        "gi:finish:Level1",
        "weather:loaded:Level1",
      ]);
      runtime.tick();
      expect(take()).toEqual(["gi:tick:weather@Level1", "weather:tick"]);

      const spawned = runtime.spawnScriptedActor({ classId: "Mover" })!;
      world.destroyActor(spawned.guid);
      world.flushPending();
      expect(take()).toEqual([`weather:spawned:${spawned.guid}`, `begin:${spawned.guid}`, `weather:destroyed:${spawned.guid}`]);

      // Departing actors are not reported: the subsystem Ends before teardown.
      runtime.executeConsoleCommand("changescene Level2");
      expect(take()).toEqual(["weather:end:scene-subsystem:WeatherSubsystem:1:weather@Level1", "gi:exit:Level1:null"]);
      runtime.notifySceneModelsReady("scene-2", 2);
      expect(take()).toEqual([
        "weather:init:scene-subsystem:WeatherSubsystem:2",
        "weather:spawned:b1", "begin:b1",
        "gi:finish:Level2",
        "weather:loaded:Level2",
      ]);

      runtime.stop();
      expect(take()).toEqual(["weather:end:scene-subsystem:WeatherSubsystem:2:weather@Level2", "gi:exit:Level2:null"]);
      expect(scriptErrors(commands)).toEqual([]);
    } finally { runtime.stop(); }
  });

  it("stay callable from a sibling's On End on Change Scene and on Stop", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      playScene: sceneNamed("Level1"), playSceneGuid: "scene-1",
      onCommand: (command) => commands.push(command),
    });
    const take = scriptLog(commands);
    await runtime.loadScripts([
      classScript("Alpha", "SceneSubsystem", {}, { functions: 'export function Ping(ctx) { return { text: "alpha-pong" }; }' }),
      // Beta Ends first (reverse class-id order), while Alpha is still live.
      classScript("Beta", "SceneSubsystem", {
        "flow.event.end": { gets: { alpha: "Alpha" }, body: 'log("beta:end:" + ctx.invokeFunction(alpha, "Ping", {}).text);' },
      }),
    ]);
    try {
      runtime.realizePlayWorld();
      runtime.start();
      runtime.executeConsoleCommand("changescene scene-1");
      expect(take()).toEqual(["beta:end:alpha-pong"]);
      runtime.stop();
      expect(take()).toEqual(["beta:end:alpha-pong"]);
    } finally { runtime.stop(); }
  });

  it("report streamed scenes and their actors once in play, never for the main scene's teardown", async () => {
    const commands: CommandMessage[] = [];
    const marker = createActor("left", "Left", { classId: "SceneStreamingActor",
      components: [{ id: "stream", classId: "SceneStreamingComponent", properties: { sceneGuid: "child", sceneName: "Child" } }] });
    const runtime = createInProcessRuntime({
      seed: 1, seedDemoActors: false, preferSoftwarePhysics: true, deferSceneModelsReady: true,
      playScene: { ...createDefaultScene(), name: "Parent", actors: [marker] }, playSceneGuid: "parent",
      sceneLibrary: { child: { ...createDefaultScene(), name: "Child", actors: [createActor("kid", "Kid", { classId: "Kid" })] } },
      onCommand: (command) => commands.push(command),
    });
    const take = scriptLog(commands);
    await runtime.loadScripts([
      weather,
      // A streamed actor's Get still answers the main scene's subsystem.
      classScript("Kid", "Actor", {
        "flow.event.beginPlay": { gets: { weather: "WeatherSubsystem" }, body: 'log("kid-begin:" + weather.guid);' },
      }),
    ]);
    const world = runtime.getWorld();
    const readyStream = async (afterLoadId: number) => {
      await vi.waitFor(() => expect(commands.some((command) =>
        command.type === "sceneStreamRealized" && command.streamLoadId > afterLoadId)).toBe(true));
      const realized = [...commands].reverse().find((command) => command.type === "sceneStreamRealized");
      if (realized?.type !== "sceneStreamRealized") throw new Error("missing stream realization");
      return realized.streamLoadId;
    };
    try {
      runtime.realizePlayWorld();
      runtime.notifySceneModelsReady("parent", 1);
      runtime.start();
      const left = world.findActor("left")!;
      const mainSubsystems = [...world.getSceneSubsystems()];
      take();

      const loading = runtime.loadSceneStream(left);
      const firstLoad = await readyStream(0);
      expect(take()).toEqual([]);
      runtime.notifySceneStreamReady("left", firstLoad);
      await loading;
      const kid = world.getActors().find((actor) => actor.classId === "Kid")!;
      expect(take()).toEqual([
        `weather:spawned:${kid.guid}`, "kid-begin:scene-subsystem:WeatherSubsystem:1",
        "weather:streamLoaded:left:Child",
      ]);
      expect(world.getSceneSubsystems()).toEqual(mainSubsystems);
      await runtime.unloadSceneStream(left);
      expect(take()).toEqual([`weather:destroyed:${kid.guid}`, "weather:streamUnloaded:left:Child"]);

      // Unloaded before it was ready: its actors never entered play.
      const cancelled = runtime.loadSceneStream(left);
      void cancelled.catch(() => {});
      const secondLoad = await readyStream(firstLoad);
      await runtime.unloadSceneStream(left);
      expect(take()).toEqual([]);

      const reloading = runtime.loadSceneStream(left);
      runtime.notifySceneStreamReady("left", await readyStream(secondLoad));
      await reloading;
      take();
      runtime.executeConsoleCommand("changescene parent");
      expect(take()).toEqual(["weather:end:scene-subsystem:WeatherSubsystem:1:weather@Parent"]);
      expect(scriptErrors(commands)).toEqual([]);
    } finally { runtime.stop(); }
  });

  it("report SceneLayers but not their overlay actors", async () => {
    const commands: CommandMessage[] = [];
    const layerDocument = createDefaultSceneLayer();
    layerDocument.actors = [createActor("hud", "Hud", { classId: "SceneLayerActor" })];
    const runtime = createInProcessRuntime({
      seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      playScene: sceneNamed("Level1"), playSceneGuid: "scene-1", sceneLayerLibrary: { hud: layerDocument },
      onCommand: (command) => commands.push(command),
    });
    const take = scriptLog(commands);
    await runtime.loadScripts([weather]);
    try {
      runtime.realizePlayWorld();
      runtime.start();
      take();
      const layer = runtime.createSceneLayer("hud")!;
      runtime.removeSceneLayer(layer.guid);
      expect(take()).toEqual([`weather:layerAdded:${layer.guid}`, `weather:layerRemoved:${layer.guid}`]);
      expect(scriptErrors(commands)).toEqual([]);
    } finally { runtime.stop(); }
  });

  it("resolve an ambiguous Get to the first leaf in class-id order and warn once per session", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      playScene: sceneNamed("Level1"), playSceneGuid: "scene-1",
      onCommand: (command) => commands.push(command),
    });
    const take = scriptLog(commands);
    await runtime.loadScripts([
      classScript("WeatherBase", "SceneSubsystem", { "flow.event.init": 'log("init:" + ctx.self.classId);' }),
      classScript("Snow", "WeatherBase", {}),
      classScript("Rain", "WeatherBase", {}),
      classScript("GameInstance", "GameInstance", {
        "flow.event.tick": { gets: { weather: "WeatherBase" }, body: 'log("gi:" + weather.classId);' },
      }),
    ]);
    try {
      runtime.realizePlayWorld();
      runtime.start();
      runtime.tick();
      runtime.tick();
      // A reload creates fresh instances; the same ambiguity is not reported again.
      runtime.executeConsoleCommand("changescene scene-1");
      runtime.tick();
      expect(take()).toEqual(["init:Rain", "init:Snow", "gi:Rain", "gi:Rain", "init:Rain", "init:Snow", "gi:Rain"]);
      expect(commands.filter((command) => command.type === "log" && command.severity === "warning" &&
        command.message.includes("WeatherBase"))).toHaveLength(1);
    } finally { runtime.stop(); }
  });
});
