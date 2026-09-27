import { expect, it } from "vitest";
import {
  actorRef, arrayOf, assetRef, compileGraph, enumRef, isAssignable,
  ENGINE_RENDER_TARGET_MODE_ENUM_ID,
  type GraphNode, type LogicGraph, type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "./index";

function node(registry: NodeRegistry, id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode {
  return { id, typeId, position: { x: 0, y: 0 }, properties, pins: registry.get(typeId)!.pins(properties) };
}
function edge(id: string, sourceNodeId: string, sourcePinId: string, targetNodeId: string, targetPinId: string) {
  return { id, sourceNodeId, sourcePinId, targetNodeId, targetPinId };
}
function run(graph: LogicGraph, registry: NodeRegistry, ctx: unknown): void {
  const compiled = compileGraph(graph, { assetGuid: "graph", registry });
  const source = compiled.source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
  (new Function(`${source}\nreturn run;`)() as (ctx: unknown) => void)(ctx);
}

it("compiles actor filtering with live actor arrays and captures after updating them", () => {
  const registry = createDefaultNodeRegistry();
  const graph: LogicGraph = { id: "capture", kind: "event", nodes: [
    node(registry, "entry", "flow.entry"),
    node(registry, "source", "debug.executeJavaScript", {
      outputs: [{ name: "capture", type: actorRef("RenderTargetCapture") }, { name: "actors", type: arrayOf(actorRef("Actor")) }],
      body: "capture = ctx.capture; actors = ctx.actors;",
    }),
    node(registry, "set", "render-target.setActors"),
    node(registry, "filter", "render-target.setOnlyActors", { "default:value": true }),
    node(registry, "get", "render-target.getActors"),
    node(registry, "sink", "debug.executeJavaScript", {
      inputs: [{ name: "actors", type: arrayOf(actorRef("Actor")) }], body: "ctx.received = actors;",
    }),
    node(registry, "capture", "render-target.capture"),
  ], edges: [
    edge("start", "entry", "execOut", "source", "execIn"),
    edge("set", "source", "execOut", "set", "execIn"),
    edge("actors", "source", "out_actors", "set", "value"),
    edge("filter", "set", "execOut", "filter", "execIn"),
    edge("sink", "filter", "execOut", "sink", "execIn"),
    edge("get", "get", "value", "sink", "in_actors"),
    edge("capture", "sink", "execOut", "capture", "execIn"),
    ...["set", "get", "filter", "capture"].map((id) => edge(`ref-${id}`, "source", "out_capture", id, "capture")),
  ] };
  const capture = { id: "camera" };
  const actors = [{ id: "hero" }, { id: "floor" }];
  const properties: Record<string, unknown> = {};
  const captured: unknown[] = [];
  const ctx = {
    capture, actors, received: null as unknown,
    setRenderTargetCaptureProperty: (target: unknown, key: string, value: unknown) => {
      expect(target).toBe(capture); properties[key] = value;
    },
    getRenderTargetCaptureProperty: (target: unknown, key: string) => {
      expect(target).toBe(capture); return properties[key];
    },
    captureRenderTarget: (target: unknown) => captured.push([target, properties.captureOnlyActors, properties.actorIds]),
  };
  run(graph, registry, ctx);
  expect(ctx.received).toBe(actors);
  expect(captured).toEqual([[capture, true, actors]]);
});

it("reads the asset's engine enum and permits its texture output in material sampler pins", () => {
  const registry = createDefaultNodeRegistry();
  const mode = registry.get("render-target.getMode")!.pins({}).find((pin) => pin.id === "mode")!.type;
  expect(isAssignable(mode, enumRef(ENGINE_RENDER_TARGET_MODE_ENUM_ID))).toBe(true);
  expect(isAssignable(assetRef("RenderTargetTexture"), assetRef("Texture"))).toBe(true);
  expect(isAssignable(assetRef("Texture"), assetRef("RenderTargetTexture"))).toBe(false);
  const ctx = { received: "", getRenderTargetMode: (guid: string) => guid === "depth-target" ? "DepthPass" : "SceneColor" };
  run({ id: "mode", kind: "event", nodes: [
    node(registry, "entry", "flow.entry"),
    node(registry, "mode", "render-target.getMode", { "default:target": "depth-target" }),
    node(registry, "sink", "debug.executeJavaScript", {
      inputs: [{ name: "mode", type: enumRef(ENGINE_RENDER_TARGET_MODE_ENUM_ID) }], body: "ctx.received = mode;",
    }),
  ], edges: [edge("start", "entry", "execOut", "sink", "execIn"), edge("mode", "mode", "mode", "sink", "in_mode")] }, registry, ctx);
  expect(ctx.received).toBe("DepthPass");
});
