import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  clearValidationRules,
  compileGraph,
  validateGraphs,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
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

  it("errors when a SceneLayer post-process pin is not a postProcess material", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "reg", "scene-layer.registerPostProcess", {
          "default:material": "bloom",
        }),
      ],
      edges: [],
    };
    const diagnostics = validateGraphs([graph], {
      assetGuid: "a",
      materialDomains: { bloom: "surface" },
    });
    expect(diagnostics.some((entry) => entry.code === "scene-layer.postProcessDomain")).toBe(
      true,
    );
  });

  it("accepts a postProcess material on Register Scene Layer Post-processing", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "reg", "scene-layer.registerPostProcess", {
          "default:material": "bloom",
        }),
      ],
      edges: [],
    };
    const diagnostics = validateGraphs([graph], {
      assetGuid: "a",
      materialDomains: { bloom: "postProcess" },
    });
    expect(
      diagnostics.filter((entry) => entry.code === "scene-layer.postProcessDomain"),
    ).toEqual([]);
  });
});
