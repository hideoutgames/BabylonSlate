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

  it("compiles Create Scene Layer onto ctx.createSceneLayer", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "create", "scene-layer.create"),
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
    expect(compiled.source).toContain("ctx.createSceneLayer(");
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
