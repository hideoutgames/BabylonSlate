import { describe, expect, it } from "vitest";
import {
  compileGraph,
  isDevelopmentOnlyNode,
  pin,
  EXEC,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "./index";

function node(
  registry: NodeRegistry,
  id: string,
  typeId: string,
  properties: Record<string, unknown> = {},
): GraphNode {
  const def = registry.get(typeId);
  return {
    id,
    typeId,
    position: { x: 0, y: 0 },
    pins: def ? def.pins(properties) : [pin("execOut", "then", "out", EXEC)],
    properties,
  };
}

const DRAW_IDS = [
  "debug.drawLine",
  "debug.drawPoint",
  "debug.drawBox",
  "debug.drawSphere",
  "debug.drawCircle",
  "debug.drawRectangle",
  "debug.drawSquare",
  "debug.drawCone",
  "debug.drawCylinder",
  "debug.drawArrow",
  "debug.drawFrustum",
  "debug.drawCoordinateSystem",
] as const;

describe("Draw Debug nodes", () => {
  it("registers Draw Debug catalog nodes as development-only by default", () => {
    const registry = createDefaultNodeRegistry();
    for (const id of DRAW_IDS) {
      const def = registry.get(id);
      expect(def, id).toBeDefined();
      expect(def?.developmentOnlyByDefault).toBe(true);
      expect(def?.title.startsWith("Draw Debug")).toBe(true);
      expect(
        isDevelopmentOnlyNode({
          id,
          typeId: id,
          position: { x: 0, y: 0 },
          pins: [],
          properties: {},
        }),
      ).toBe(true);
    }
  });

  it("compiles Draw Debug Line with catalog defaults", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "draw", "debug.drawLine"),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "draw",
          targetPinId: "execIn",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain('kind: "line"');
    expect(compiled.source).toContain("ctx.drawDebug(");
    expect(compiled.source).toContain('"x":1');
    const stripped = compileGraph(graph, {
      assetGuid: "a",
      registry,
      stripDevelopmentOnly: true,
    });
    expect(stripped.source).not.toContain("ctx.drawDebug");
  });

  it("keeps Draw Debug Line in export when Development Only is unchecked", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "draw", "debug.drawLine", { developmentOnly: false }),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "draw",
          targetPinId: "execIn",
        },
      ],
    };
    const stripped = compileGraph(graph, {
      assetGuid: "a",
      registry,
      stripDevelopmentOnly: true,
    });
    expect(stripped.source).toContain("ctx.drawDebug");
  });
});
