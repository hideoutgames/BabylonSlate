import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@haptic/bridge";
import { createActor, createDefaultScene, createDefaultSceneLayer, createMeshComponent, createTimelineClip, type SerializedScene, type SerializedTimelineClip } from "@haptic/core";
import { sceneAssetClassId, sceneLayerAssetClassId } from "@haptic/object-model";
import { compileGraph, STRING, type GraphNode, type LogicGraph } from "@haptic/scripting";
import { createDefaultNodeRegistry, OWNED_ACTOR_GET_NODE_ID, OWNED_COMPONENT_GET_NODE_ID, OWNED_TIMELINE_CLIP_GET_NODE_ID } from "@haptic/scripting-nodes";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";

/** A SceneScript / SceneLayerScript that records its lifecycle on its owner and in the log. */
function lifecycleScript(classId: string, parentClassId: "Scene" | "SceneLayer"): CompiledScript {
  return {
    classId, parentClassId, assetGuid: classId.split(":")[1]!, anchors: [],
    variables: [{ name: "score", type: "int", defaultValue: 5 }],
    source: `export function begin(ctx) {
        ctx.self.setVariable("began", ctx.self.getVariable("score"));
        ctx.log("log", "Script", "begin:" + ${JSON.stringify(classId)} + ":" + ctx.self.guid);
      }
      export function tick(ctx) { ctx.self.setVariable("ticks", Number(ctx.self.getVariable("ticks") ?? 0) + 1); }
      export function destroyed(ctx) { ctx.log("log", "Script", "destroyed:" + ${JSON.stringify(classId)} + ":" + ctx.self.guid); }`,
    entryPoints: [
      { name: "begin", event: "onBeginPlay", isAsync: false },
      { name: "tick", event: "onTick", isAsync: false },
      { name: "destroyed", event: "onDestroyed", isAsync: false },
    ],
  };
}

function logs(commands: readonly CommandMessage[]): string[] {
  return commands.flatMap((command) => command.type === "log" ? [String((command as { message: string }).message)] : []);
}

function scene(name: string, layers: string[] = []): SerializedScene {
  const value = { ...createDefaultScene(), name, actors: [createActor("hero", "Hero")] };
  value.settings.sceneLayers = layers.map((assetGuid, index) => ({ assetGuid, zOrder: index, enabled: true }));
  return value;
}

describe("SceneScript and SceneLayerScript", () => {
  it("runs the main Scene's script from its readiness until the Scene changes", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      playScene: scene("Level1"), playSceneGuid: "level-1",
      sceneLibrary: { "level-2": scene("Level2") },
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([lifecycleScript(sceneAssetClassId("level-1"), "Scene")]);
    runtime.realizePlayWorld();
    const level1 = runtime.getWorld().currentScene!;
    expect(level1.classId).toBe(sceneAssetClassId("level-1"));
    // Class variable defaults apply before Begin Play reads them.
    expect(level1.getVariable("began")).toBe(5);
    expect(runtime.getWorld().findActor("hero")).toBeDefined();
    runtime.start();
    runtime.tick();
    runtime.tick();
    expect(level1.getVariable("ticks")).toBe(2);

    runtime.executeConsoleCommand("changescene Level2");
    expect(logs(commands)).toContain(`destroyed:${sceneAssetClassId("level-1")}:${level1.guid}`);
    runtime.tick();
    expect(level1.getVariable("ticks")).toBe(2);
    // Level2 has no script: nothing runs on it.
    expect(runtime.getWorld().currentScene?.getVariable("began")).toBeUndefined();
    runtime.stop();
  });

  it("gives each Scene Layer instance its own script, ended when its owning Scene unloads", async () => {
    const commands: CommandMessage[] = [];
    const overlay = { ...createDefaultSceneLayer(), actors: [createActor("panel", "Panel", {
      classId: "SceneLayerActor", components: [createMeshComponent("panel-mesh", "box")] })] };
    const runtime = createInProcessRuntime({
      seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      playScene: scene("Level1", ["overlay", "overlay"]), playSceneGuid: "level-1",
      sceneLibrary: { "level-2": scene("Level2") },
      sceneLayerLibrary: { overlay },
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([lifecycleScript(sceneLayerAssetClassId("overlay"), "SceneLayer")]);
    runtime.realizePlayWorld();
    const layers = [...runtime.getWorld().getSceneLayers()];
    expect(layers).toHaveLength(2);
    for (const layer of layers) {
      expect(layer.classId).toBe(sceneLayerAssetClassId("overlay"));
      expect(layer.getVariable("began")).toBe(5);
    }
    runtime.start();
    runtime.tick();
    expect(layers.map((layer) => layer.getVariable("ticks"))).toEqual([1, 1]);

    runtime.executeConsoleCommand("changescene Level2");
    for (const layer of layers) {
      expect(logs(commands)).toContain(`destroyed:${sceneLayerAssetClassId("overlay")}:${layer.guid}`);
    }
    runtime.tick();
    expect(layers.map((layer) => layer.getVariable("ticks"))).toEqual([1, 1]);
    runtime.stop();
  });
});

describe("Get <Actor> and Get <Component> (<Actor>)", () => {
  const registry = createDefaultNodeRegistry();
  const node = (id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode => ({
    id, typeId, position: { x: 0, y: 0 }, pins: registry.get(typeId)!.pins(properties), properties,
  });
  /** Begin Play logs the guid of the owner's `panel` actor and of its `panel-mesh` component. */
  function referenceScript(classId: string, parentClassId: "Scene" | "SceneLayer"): CompiledScript {
    const graph: LogicGraph = {
      id: "event-graph", kind: "event",
      nodes: [
        node("begin", "flow.event.beginPlay"),
        node("actor", OWNED_ACTOR_GET_NODE_ID, { sceneActorId: "panel", sceneActorName: "Panel", sceneActorClassId: "Actor" }),
        node("component", OWNED_COMPONENT_GET_NODE_ID, { sceneActorId: "panel", sceneActorName: "Panel", sceneComponentId: "panel-mesh", sceneComponentName: "Mesh", sceneComponentClassId: "MeshComponent" }),
        node("missing", OWNED_ACTOR_GET_NODE_ID, { sceneActorId: "gone", sceneActorName: "Gone" }),
        node("log", "debug.executeJavaScript", {
          inputs: [{ name: "actor", type: STRING }, { name: "component", type: STRING }, { name: "missing", type: STRING }],
          outputs: [],
          body: 'ctx.log("log", "Script", "refs:" + ctx.self.guid + ":" + actor?.guid + ":" + component?.owner?.guid + ":" + component?.classId + ":" + missing);',
        }),
      ],
      edges: [
        { id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "log", targetPinId: "execIn" },
        { id: "e2", sourceNodeId: "actor", sourcePinId: "actor", targetNodeId: "log", targetPinId: "in_actor" },
        { id: "e3", sourceNodeId: "component", sourcePinId: "component", targetNodeId: "log", targetPinId: "in_component" },
        { id: "e4", sourceNodeId: "missing", sourcePinId: "actor", targetNodeId: "log", targetPinId: "in_missing" },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: classId, registry });
    return { classId, parentClassId, assetGuid: classId, source: compiled.source, anchors: compiled.anchors, entryPoints: compiled.entryPoints };
  }

  it("resolves the owner's own placed actor and component, per Scene Layer instance", async () => {
    const commands: CommandMessage[] = [];
    const panel = (classId: string) => createActor("panel", "Panel", { classId, components: [createMeshComponent("panel-mesh", "box")] });
    const level = { ...scene("Level1", ["overlay", "overlay"]), actors: [panel("Actor")] };
    const runtime = createInProcessRuntime({
      seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      playScene: level, playSceneGuid: "level-1",
      sceneLayerLibrary: { overlay: { ...createDefaultSceneLayer(), actors: [panel("SceneLayerActor")] } },
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      referenceScript(sceneAssetClassId("level-1"), "Scene"),
      referenceScript(sceneLayerAssetClassId("overlay"), "SceneLayer"),
    ]);
    runtime.realizePlayWorld();
    const world = runtime.getWorld();
    const references = logs(commands).filter((message) => message.startsWith("refs:"));
    // The main Scene's `panel` is its own actor, never a layer's of the same authored id.
    expect(references).toContain(`refs:${world.currentScene!.guid}:panel:panel:MeshComponent:null`);
    for (const layer of world.getSceneLayers()) {
      expect(references).toContain(`refs:${layer.guid}:${layer.guid}:panel:${layer.guid}:panel:MeshComponent:null`);
    }
    expect(references).toHaveLength(3);
    runtime.stop();
  });
});

describe("Get <Name> Timeline Clip", () => {
  const registry = createDefaultNodeRegistry();
  const node = (id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode => ({
    id, typeId, position: { x: 0, y: 0 }, pins: registry.get(typeId)!.pins(properties), properties,
  });
  /** Moves `panel` along `axis` from 0 to 4 over 1 second. */
  const slide = (id: string, name: string, axis: "x" | "y", autoPlay: boolean): SerializedTimelineClip => ({
    ...createTimelineClip(id, name),
    length: 1,
    autoPlay,
    objects: [{ id: "o", actorId: "panel", tracks: [{
      id: "t", target: { kind: "transform", property: "location" }, valueType: "vec3",
      keys: [0, 1].map((Time) => ({
        id: `k${Time}`, Time, Value: { x: 0, y: 0, z: 0, [axis]: Time * 4 },
        Interpolation: "linear" as const, ArriveTangent: 0, LeaveTangent: 0,
      })),
    }] }],
  });
  /** Begin Play plays the owner's `reveal` clip and logs whether it is playing. */
  function playScript(classId: string): CompiledScript {
    const graph: LogicGraph = {
      id: "event-graph", kind: "event",
      nodes: [
        node("begin", "flow.event.beginPlay"),
        node("clip", OWNED_TIMELINE_CLIP_GET_NODE_ID, { sceneTimelineClipId: "reveal", sceneTimelineClipName: "Reveal" }),
        node("missing", OWNED_TIMELINE_CLIP_GET_NODE_ID, { sceneTimelineClipId: "gone", sceneTimelineClipName: "Gone" }),
        node("play", "debug.executeJavaScript", {
          inputs: [{ name: "clip", type: STRING }, { name: "missing", type: STRING }],
          outputs: [],
          body: 'ctx.callComponentFunction(clip, "timelinePlay", {}); ctx.log("log", "Script", "clip:" + clip?.classId + ":" + ctx.callComponentFunction(clip, "timelineIsPlaying", {}).playing + ":" + missing);',
        }),
      ],
      edges: [
        { id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "play", targetPinId: "execIn" },
        { id: "e2", sourceNodeId: "clip", sourcePinId: "clip", targetNodeId: "play", targetPinId: "in_clip" },
        { id: "e3", sourceNodeId: "missing", sourcePinId: "clip", targetNodeId: "play", targetPinId: "in_missing" },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: classId, registry });
    return { classId, parentClassId: "SceneLayer", assetGuid: classId, source: compiled.source, anchors: compiled.anchors, entryPoints: compiled.entryPoints };
  }

  it("plays each Scene Layer copy's own clip, and Auto Plays the main Scene's", async () => {
    const commands: CommandMessage[] = [];
    const panel = () => createActor("panel", "Panel", { components: [createMeshComponent("panel-mesh", "box")] });
    const level = { ...scene("Level1", ["overlay", "overlay"]), actors: [panel()], timelineClips: [slide("intro", "Intro", "y", true)] };
    const runtime = createInProcessRuntime({
      seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      playScene: level, playSceneGuid: "level-1",
      sceneLayerLibrary: { overlay: { ...createDefaultSceneLayer(), actors: [panel()], timelineClips: [slide("reveal", "Reveal", "x", false)] } },
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([playScript(sceneLayerAssetClassId("overlay"))]);
    runtime.realizePlayWorld();
    expect(logs(commands).filter((message) => message.startsWith("clip:"))).toEqual(["clip:TimelineClip:true:null", "clip:TimelineClip:true:null"]);
    runtime.start();
    const ticks = (count: number) => { for (let index = 0; index < count; index += 1) runtime.tick(); };
    ticks(30);
    const world = runtime.getWorld();
    const layers = world.getSceneLayers();
    expect(layers).toHaveLength(2);
    for (const layer of layers) {
      expect(world.findActor(`${layer.guid}:panel`)!.transform.position.x).toBeCloseTo(2, 1);
    }
    expect(world.findActor("panel")!.transform.position.y).toBeCloseTo(2, 1);
    ticks(60);
    for (const layer of layers) expect(world.findActor(`${layer.guid}:panel`)!.transform.position.x).toBe(4);
    expect(world.findActor("panel")!.transform.position).toMatchObject({ x: 0, y: 4 });
    runtime.stop();
  });
});
