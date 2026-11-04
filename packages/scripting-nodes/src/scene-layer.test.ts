import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  clearValidationRules,
  compileGraph,
  validateGraphs,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@haptic/scripting";
import { createDefaultNodeRegistry } from "./index";
import { registerSceneLayerValidationRules } from "./scene-layer";

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

describe("scene-layer nodes", () => {
  beforeEach(() => {
    clearValidationRules();
    registerSceneLayerValidationRules();
  });
  afterEach(() => {
    clearValidationRules();
  });

  it("waits for Create Scene Layer preparation before continuing execution", async () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "create", "scene-layer.create", { "default:asset": "hud", "default:zOrder": 3 }),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "create",
          targetPinId: "execIn",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    const body = compiled.source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
    const onBeginPlay = new Function(`${body}\nreturn onBeginPlay;`)() as (ctx: unknown) => Promise<void>;
    let ready!: () => void;
    let finished = false;
    const operation = onBeginPlay({ createSceneLayerAsync: (guid: string, zOrder: number) => {
      expect([guid, zOrder]).toEqual(["hud", 3]);
      return new Promise(resolve => { ready = () => resolve({ guid: "hud-instance" }); });
    } }).then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    ready();
    await operation;
    expect(finished).toBe(true);
  });

  it.each(["scene-layer.registerPostProcess", "scene-layer.unregisterPostProcess", "scene.registerPostProcess", "scene.unregisterPostProcess"])(
    "errors when %s's Material pin is not a postProcess material",
    (typeId) => {
      const registry = createDefaultNodeRegistry();
      const graph: LogicGraph = {
        id: "g",
        kind: "event",
        nodes: [
          node(registry, "begin", "flow.event.beginPlay"),
          node(registry, "reg", typeId, {
            "default:material": "bloom",
          }),
        ],
        edges: [
          { id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "reg", targetPinId: "execIn" },
        ],
      };
      const diagnostics = validateGraphs([graph], {
        assetGuid: "a",
        materialDomains: { bloom: "surface" },
      });
      expect(diagnostics.filter((entry) => entry.code === "scene-layer.postProcessDomain").map((entry) => entry.message))
        .toEqual(["Post-processing requires a postProcess Material (got surface)"]);
    },
  );

  it.each([
    ["scene.registerPostProcess", "registerScenePostProcess"],
    ["scene-layer.registerPostProcess", "registerSceneLayerPostProcess"],
  ] as const)("hands %s's new pass to the next node as its Material Object", (typeId, method) => {
    const layered = method === "registerSceneLayerPostProcess";
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "layer", "scene-layer.getOwningSceneLayer"),
        node(registry, "reg", typeId, { "default:material": "night" }),
        node(registry, "set", "material.setFloatParameter", { "default:name": "Darkness", "default:value": 0.6 }),
        node(registry, "unreg", "scene.unregisterPostProcess", { "default:material": "day" }),
      ],
      edges: [
        { id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "reg", targetPinId: "execIn" },
        { id: "e2", sourceNodeId: "reg", sourcePinId: "execOut", targetNodeId: "set", targetPinId: "execIn" },
        { id: "e3", sourceNodeId: "reg", sourcePinId: "pass", targetNodeId: "set", targetPinId: "material" },
        { id: "e4", sourceNodeId: "set", sourcePinId: "execOut", targetNodeId: "unreg", targetPinId: "execIn" },
        ...(layered ? [{ id: "e5", sourceNodeId: "layer", sourcePinId: "out", targetNodeId: "reg", targetPinId: "layer" }] : []),
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    const body = compiled.source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
    const onBeginPlay = new Function(`${body}\nreturn onBeginPlay;`)() as (ctx: unknown) => unknown;
    const pass = { guid: "pass-material" };
    const calls: unknown[][] = [];
    void onBeginPlay({
      [method]: (...args: unknown[]) => { calls.push(["register", ...args]); return pass; },
      setMaterialFloatParameter: (...args: unknown[]) => calls.push(["set", ...args]),
      unregisterScenePostProcess: (guid: string) => calls.push(["unregister", guid]),
      self: { guid: "hero" },
      getOwningSceneLayer: () => "hud",
    });
    expect(calls).toEqual([
      ["register", ...(layered ? ["hud"] : []), "night"],
      ["set", pass, "Darkness", 0.6],
      ["unregister", "day"],
    ]);
  });

  it("accepts a postProcess material on Register Scene Layer Post-processing", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "reg", "scene-layer.registerPostProcess", {
          "default:material": "bloom",
        }),
      ],
      edges: [
        { id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "reg", targetPinId: "execIn" },
      ],
    };
    const diagnostics = validateGraphs([graph], {
      assetGuid: "a",
      materialDomains: { bloom: "postProcess" },
    });
    expect(
      diagnostics.filter((entry) => entry.code === "scene-layer.postProcessDomain"),
    ).toEqual([]);
  });

  it("ignores the stored Material when the pin is wired", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "asset", "material.getMaterialAsset"),
        node(registry, "reg", "scene-layer.registerPostProcess", {
          "default:material": "bloom",
        }),
      ],
      edges: [
        { id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "reg", targetPinId: "execIn" },
        { id: "e2", sourceNodeId: "asset", sourcePinId: "asset", targetNodeId: "reg", targetPinId: "material" },
      ],
    };
    const diagnostics = validateGraphs([graph], {
      assetGuid: "a",
      materialDomains: { bloom: "surface" },
    });
    expect(
      diagnostics.filter((entry) => entry.code === "scene-layer.postProcessDomain"),
    ).toEqual([]);
  });
});
