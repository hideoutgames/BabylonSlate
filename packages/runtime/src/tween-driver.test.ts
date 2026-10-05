import { describe, expect, it } from "vitest";
import { createActor, createDefaultScene, createDefaultSceneLayer } from "@babylonslate/core";
import type { CommandMessage } from "@babylonslate/bridge";
import { compileGraph, type GraphNode, type LogicGraph } from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";

function floatScript(): CompiledScript {
  const registry = createDefaultNodeRegistry();
  const node = (id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode =>
    ({ id, typeId, properties, pins: registry.get(typeId)!.pins(properties), position: { x: 0, y: 0 } });
  const graph: LogicGraph = { id: "tween", kind: "event", nodes: [
    node("begin", "flow.event.beginPlay"),
    node("value", "variables.get", { variableName: "amount", typeId: "float", implicitSelf: true }),
    node("tween", "tween.float", { a: 0, b: 8 }),
    node("done", "debug.log", { message: "completed" }),
  ], edges: [
    { id: "exec", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "tween", targetPinId: "execIn" },
    { id: "value", sourceNodeId: "value", sourcePinId: "value", targetNodeId: "tween", targetPinId: "target" },
    { id: "done", sourceNodeId: "tween", sourcePinId: "execOut", targetNodeId: "done", targetPinId: "execIn" },
  ] };
  const compiled = compileGraph(graph, { registry, assetGuid: "tween" });
  return { classId: "TweenActor", assetGuid: "tween", source: compiled.source, anchors: compiled.anchors, entryPoints: compiled.entryPoints };
}

const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

describe("Tween runtime integration", () => {
  it("runs a compiled one-shot reference tween using pause and time dilation, then executes Completed once", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true, dt: 0.5, onCommand: command => commands.push(command) });
    try {
      await runtime.loadScripts([floatScript()]);
      runtime.start();
      const actor = runtime.spawnScriptedActor({ classId: "TweenActor" })!;
      expect(actor.getVariable("amount")).toBe(0);
      runtime.tick(); expect(actor.getVariable("amount")).toBe(2);
      runtime.pause(); runtime.tick(); expect(actor.getVariable("amount")).toBe(2);
      runtime.resume();
      expect(runtime.executeConsoleCommand("slomo 0.5").success).toBe(true);
      runtime.tick(); expect(actor.getVariable("amount")).toBe(3);
      runtime.executeConsoleCommand("slomo 1");
      runtime.tick(); runtime.tick(); runtime.tick();
      await flush();
      expect(actor.getVariable("amount")).toBe(8);
      expect(commands.filter(command => command.type === "log" && command.message === "completed")).toHaveLength(1);
      runtime.tick(); await flush();
      expect(commands.filter(command => command.type === "log" && command.message === "completed")).toHaveLength(1);
    } finally { runtime.stop(); }
  });

  it.each(["stop", "destroy"] as const)("does not resume Completed after %s before the completion microtask", async action => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true, dt: 2, onCommand: command => commands.push(command) });
    try {
      await runtime.loadScripts([floatScript()]); runtime.start();
      const actor = runtime.spawnScriptedActor({ classId: "TweenActor" })!;
      runtime.tick();
      if (action === "stop") runtime.stop();
      else { runtime.getWorld().destroyActor(actor.guid); runtime.getWorld().flushPending(); }
      await flush();
      expect(commands.some(command => command.type === "log" && command.message === "completed")).toBe(false);
    } finally { runtime.stop(); }
  });

  it("publishes component fades without mesh rebuilds and cancels when its SceneLayer is removed", async () => {
    const layer = createDefaultSceneLayer();
    layer.actors = [createActor("label", "Label", { classId: "FadeLabel", components: [
      { id: "text", classId: "2DTextComponent", properties: { text: "Ready", opacity: 0.8 } },
    ] })];
    const script: CompiledScript = { classId: "FadeLabel", parentClassId: "SceneLayerActor", assetGuid: "fade", anchors: [],
      entryPoints: [{ name: "onBeginPlay", event: "onBeginPlay", nodeId: "fade", isAsync: true }],
      source: `export async function onBeginPlay(ctx) {
        const text = ctx.getComponentById(ctx.self, "text");
        const move = ctx.tweenProperty(text, "component.position", "vec3", {x:0,y:0,z:0}, {x:2,y:0,z:0}, 2, "linear", "local");
        const fade = await ctx.tweenProperty(text, "overlay.opacity", "float", 0.8, 0, 2, "linear");
        if (fade && await move) ctx.log("log", "Tween", "fade complete");
      }`,
    };
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true, dt: 0.5,
      playScene: createDefaultScene(), sceneLayerLibrary: { menu: layer }, onCommand: command => commands.push(command) });
    try {
      await runtime.loadScripts([script]); runtime.realizePlayWorld(); runtime.start();
      const liveLayer = runtime.createSceneLayer("menu")!;
      const assigned = commands.find(command => command.type === "assignMesh" && command.primaryComponentId === "text");
      expect(assigned).toMatchObject({ overlayStyle: { opacity: 0.8, tint: [1, 1, 1, 1] } });
      commands.length = 0;
      runtime.tick();
      const style = commands.find(command => command.type === "setOverlayVisualStyle" && command.componentId === "text");
      expect(style?.type === "setOverlayVisualStyle" ? style.style.opacity : undefined).toBeCloseTo(0.6);
      expect(style).toMatchObject({ style: { tint: [1, 1, 1, 1] } });
      expect(commands).toContainEqual(expect.objectContaining({ type: "setComponentTransforms", parts: [
        expect.objectContaining({ componentId: "text", transform: expect.objectContaining({ position: { x: 0.5, y: 0, z: 0 } }) }),
      ] }));
      expect(commands.some(command => command.type === "assignMesh")).toBe(false);
      runtime.removeSceneLayer(liveLayer.guid); runtime.tick(); runtime.tick(); runtime.tick(); await flush();
      expect(commands.some(command => command.type === "log" && command.message === "fade complete")).toBe(false);
    } finally { runtime.stop(); }
  });
});
