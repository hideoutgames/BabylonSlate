import { describe, expect, it } from "vitest";
import { createActor, createDefaultScene, createDefaultSceneLayer } from "@haptic/core";
import type { CommandMessage } from "@haptic/bridge";
import { compileGraph, type GraphNode, type LogicGraph } from "@haptic/scripting";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";

function floatScript(): CompiledScript {
  const registry = createDefaultNodeRegistry();
  const node = (id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode =>
    ({ id, typeId, properties, pins: registry.get(typeId)!.pins(properties), position: { x: 0, y: 0 } });
  const graph: LogicGraph = { id: "tween", kind: "event", nodes: [
    node("begin", "flow.event.beginPlay"),
    node("value", "variables.get", { variableName: "amount", typeId: "float", implicitSelf: true }),
    node("tween", "tween.float", { "default:a": 0, "default:b": 8 }),
    node("done", "debug.log", { "default:message": "completed" }),
  ], edges: [
    { id: "exec", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "tween", targetPinId: "execIn" },
    { id: "value", sourceNodeId: "value", sourcePinId: "value", targetNodeId: "tween", targetPinId: "target" },
    { id: "done", sourceNodeId: "tween", sourcePinId: "execOut", targetNodeId: "done", targetPinId: "execIn" },
  ] };
  const compiled = compileGraph(graph, { registry, assetGuid: "tween" });
  return { classId: "TweenActor", assetGuid: "tween", source: compiled.source, anchors: compiled.anchors, entryPoints: compiled.entryPoints };
}

const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

/**
 * A layer actor's Begin Play through its Layer Camera: Get Layer Camera on
 * Self, Set Camera Location, Add Camera Offset (doubling it from Get Camera
 * Location), Set Camera Rotation and Zoom, then tween each from its current
 * value and log once the last finishes.
 */
function cameraRigScript(): CompiledScript {
  const registry = createDefaultNodeRegistry();
  const node = (id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode =>
    ({ id, typeId, properties, pins: registry.get(typeId)!.pins(properties), position: { x: 0, y: 0 } });
  const cameraVariable = (name: string, typeId: string, propertyKey: string, extra: Record<string, unknown> = {}) =>
    ({ variableName: name, typeId, classId: "LayerCamera", propertyKey, scope: "member", ...extra });
  const exec = (from: string, to: string, fromPin = "execOut", toPin = "execIn") =>
    ({ id: `${from}-${to}`, sourceNodeId: from, sourcePinId: fromPin, targetNodeId: to, targetPinId: toPin });
  const data = (from: string, fromPin: string, to: string, pin: string) =>
    ({ id: `${from}-${to}-${pin}`, sourceNodeId: from, sourcePinId: fromPin, targetNodeId: to, targetPinId: pin });
  const graph: LogicGraph = { id: "camera", kind: "event", nodes: [
    node("begin", "flow.event.beginPlay"),
    node("self", "actor.getSelf"),
    node("camera", "variables.get", { variableName: "Layer Camera", typeId: "object", typeClassId: "LayerCamera",
      classId: "SceneLayerActor", propertyKey: "layerCamera", scope: "member", getOnly: true }),
    node("location", "variables.get", cameraVariable("Camera Location", "vec2", "location")),
    node("rotation", "variables.get", cameraVariable("Camera Rotation", "float", "rotation")),
    node("zoomValue", "variables.get", cameraVariable("Camera Zoom", "float", "zoom")),
    node("set", "variables.set", cameraVariable("Camera Location", "vec2", "location", { "default:value": { x: 2, y: 1 } })),
    node("offset", "functions.call", { functionName: "Add Camera Offset", runtime: "addLayerCameraOffset", classId: "LayerCamera", pins: [
      { name: "exec", typeId: "exec", direction: "in" }, { name: "then", typeId: "exec", direction: "out" },
      { name: "delta", typeId: "vec2", direction: "in" },
    ] }),
    node("roll", "variables.set", cameraVariable("Camera Rotation", "float", "rotation", { "default:value": 30 })),
    node("zoom", "variables.set", cameraVariable("Camera Zoom", "float", "zoom", { "default:value": 2 })),
    node("tweenRoll", "tween.layerCameraRotation", { "default:b": 90, "default:duration": 1 }),
    node("tweenZoom", "tween.layerCameraZoom", { "default:b": 4, "default:duration": 1 }),
    node("tweenLocation", "tween.layerCameraLocation", { "default:b": { x: 0, y: 0 }, "default:duration": 1 }),
    node("done", "debug.log", { "default:message": "camera done" }),
  ], edges: [
    exec("begin", "set"),
    exec("set", "offset", "execOut", "exec"),
    exec("offset", "roll", "then"),
    exec("roll", "zoom"),
    exec("zoom", "tweenRoll"),
    exec("tweenRoll", "tweenZoom"),
    exec("tweenZoom", "tweenLocation"),
    exec("tweenLocation", "done"),
    data("self", "out", "camera", "target"),
    ...["set", "offset", "roll", "zoom", "location", "rotation", "zoomValue", "tweenRoll", "tweenZoom", "tweenLocation"]
      .map((to) => data("camera", "value", to, "target")),
    data("location", "value", "offset", "delta"),
    data("rotation", "value", "tweenRoll", "a"),
    data("zoomValue", "value", "tweenZoom", "a"),
    data("location", "value", "tweenLocation", "a"),
  ] };
  const compiled = compileGraph(graph, { registry, assetGuid: "rig" });
  return { classId: "CameraRig", parentClassId: "SceneLayerActor", assetGuid: "rig", source: compiled.source, anchors: compiled.anchors, entryPoints: compiled.entryPoints };
}

describe("Tween runtime integration", () => {
  it("runs a compiled one-shot reference tween using pause and time dilation, then executes Completed once", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, preferSoftwarePhysics: true, dt: 0.5, onCommand: command => commands.push(command) });
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

  it("steps a Delay One Tick chain once per tick when one frame runs several catch-up ticks", async () => {
    const registry = createDefaultNodeRegistry();
    const node = (id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode =>
      ({ id, typeId, properties, pins: registry.get(typeId)!.pins(properties), position: { x: 0, y: 0 } });
    const steps = ["a", "b", "c"];
    // Begin Play -> (Delay One Tick -> Print) three times.
    const graph: LogicGraph = { id: "chain", kind: "event", nodes: [
      node("begin", "flow.event.beginPlay"),
      ...steps.flatMap((step) => [node(`wait-${step}`, "timers.delayOneTick"), node(`log-${step}`, "debug.log", { "default:message": step })]),
    ], edges: steps.flatMap((step, index) => [
      { id: `in-${step}`, sourceNodeId: index === 0 ? "begin" : `log-${steps[index - 1]}`, sourcePinId: "execOut", targetNodeId: `wait-${step}`, targetPinId: "execIn" },
      { id: `out-${step}`, sourceNodeId: `wait-${step}`, sourcePinId: "execOut", targetNodeId: `log-${step}`, targetPinId: "execIn" },
    ]) };
    const compiled = compileGraph(graph, { registry, assetGuid: "chain" });
    const commands: CommandMessage[] = [];
    const dt = 1 / 60;
    const runtime = createInProcessRuntime({ seed: 1, preferSoftwarePhysics: true, dt, onCommand: command => commands.push(command) });
    try {
      await runtime.loadScripts([{ classId: "Chain", assetGuid: "chain", source: compiled.source, anchors: compiled.anchors, entryPoints: compiled.entryPoints }]);
      runtime.start();
      runtime.spawnScriptedActor({ classId: "Chain" });
      // One frame that owes four ticks: Begin Play in the first, then one step in each of the next three.
      runtime.advance(4 * dt);
      // Read before any microtask runs. Waits resumed by promises would all still be pending
      // here, and the chain would move one step per frame however many ticks the frame ran.
      expect(commands.flatMap(command => command.type === "log" && command.category === "Script" ? [command.message] : [])).toEqual(steps);
    } finally { runtime.stop(); }
  });

  it("runs Completed inside the tick the tween ends in, not in a microtask after it", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, preferSoftwarePhysics: true, dt: 2, onCommand: command => commands.push(command) });
    try {
      await runtime.loadScripts([floatScript()]); runtime.start();
      runtime.spawnScriptedActor({ classId: "TweenActor" });
      runtime.tick();
      // No await between the tick and this read: the graph continued in the tick's own stack,
      // so a frame that runs several ticks resumes each wait in its own tick.
      expect(commands.some(command => command.type === "log" && command.message === "completed")).toBe(true);
    } finally { runtime.stop(); }
  });

  it("publishes component fades without mesh rebuilds and cancels when its SceneLayer is removed", async () => {
    const layer = createDefaultSceneLayer();
    layer.actors = [createActor("label", "Label", { classId: "FadeLabel", components: [
      { id: "text", classId: "2DTextComponent", properties: { text: "Ready", opacity: 0.8 } },
    ] })];
    const script: CompiledScript = { classId: "FadeLabel", parentClassId: "SceneLayerActor", assetGuid: "fade", anchors: [],
      entryPoints: [{ name: "onBeginPlay", event: "onBeginPlay", isAsync: true }],
      source: `export async function onBeginPlay(ctx) {
        const text = ctx.getComponentById(ctx.self, "text");
        const move = ctx.tweenProperty(text, "component.position", "vec3", {x:0,y:0,z:0}, {x:2,y:0,z:0}, 2, "linear", "local");
        const fade = await ctx.tweenProperty(text, "overlay.opacity", "float", 0.8, 0, 2, "linear");
        if (fade && await move) ctx.log("log", "Tween", "fade complete");
      }`,
    };
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, preferSoftwarePhysics: true, dt: 0.5,
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

  it("runs the Layer Camera members and tweens from a layer actor's graph", async () => {
    const layer = createDefaultSceneLayer();
    layer.actors = [createActor("rig", "Rig", { classId: "CameraRig" })];
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, preferSoftwarePhysics: true, dt: 0.5,
      playScene: createDefaultScene(), sceneLayerLibrary: { menu: layer }, onCommand: command => commands.push(command) });
    try {
      await runtime.loadScripts([cameraRigScript()]); runtime.realizePlayWorld(); runtime.start();
      const liveLayer = runtime.createSceneLayer("menu")!;
      for (let tick = 0; tick < 8; tick++) { runtime.tick(); await flush(); }
      expect(commands.flatMap(command => command.type === "sceneLayerCamera" ? [command.camera] : []).slice(0, 4)).toEqual([
        { x: 2, y: 1, rotation: 0, zoom: 1 },
        { x: 4, y: 2, rotation: 0, zoom: 1 },
        { x: 4, y: 2, rotation: 30, zoom: 1 },
        { x: 4, y: 2, rotation: 30, zoom: 2 },
      ]);
      expect(liveLayer.camera.state).toEqual({ x: 0, y: 0, rotation: 90, zoom: 4 });
      expect(commands.filter(command => command.type === "log" && command.message === "camera done")).toHaveLength(1);
    } finally { runtime.stop(); }
  });

  it("tweens a layer actor's own Layer Camera location, roll and zoom together", async () => {
    const layer = createDefaultSceneLayer();
    layer.actors = [createActor("rig", "Rig", { classId: "CameraRig" })];
    const script: CompiledScript = { classId: "CameraRig", parentClassId: "SceneLayerActor", assetGuid: "rig", anchors: [],
      entryPoints: [{ name: "onBeginPlay", event: "onBeginPlay", isAsync: true }],
      source: `export async function onBeginPlay(ctx) {
        const camera = ctx.getVariableFrom(ctx.self, "layerCamera");
        const moved = ctx.tweenProperty(camera, "layerCamera.location", "vec2", {x:0,y:0}, {x:4,y:2}, 2, "linear");
        const turned = ctx.tweenProperty(camera, "layerCamera.rotation", "float", 0, 90, 2, "linear");
        const zoomed = await ctx.tweenProperty(camera, "layerCamera.zoom", "float", 1, 3, 2, "linear");
        if (zoomed && await moved && await turned) ctx.log("log", "Tween", "camera complete");
      }`,
    };
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, preferSoftwarePhysics: true, dt: 0.5,
      playScene: createDefaultScene(), sceneLayerLibrary: { menu: layer }, onCommand: command => commands.push(command) });
    const cameras = () => commands.flatMap(command => command.type === "sceneLayerCamera" ? [command.camera] : []);
    try {
      await runtime.loadScripts([script]); runtime.realizePlayWorld(); runtime.start();
      const liveLayer = runtime.createSceneLayer("menu")!;
      commands.length = 0;
      runtime.tick();
      expect(cameras().at(-1)).toEqual({ x: 1, y: 0.5, rotation: 22.5, zoom: 1.5 });
      runtime.tick(); runtime.tick(); runtime.tick(); await flush();
      expect(liveLayer.camera.state).toEqual({ x: 4, y: 2, rotation: 90, zoom: 3 });
      expect(commands.filter(command => command.type === "log" && command.message === "camera complete")).toHaveLength(1);
    } finally { runtime.stop(); }
  });
});
