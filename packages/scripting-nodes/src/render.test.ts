import { describe, expect, it } from "vitest";
import {
  compileGraph,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry, renderNodes } from "./index";

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

describe("render nodes", () => {
  it("compiled Set Render Resolution calls ctx.setRenderResolution", () => {
    expect(renderNodes.map((entry) => entry.id)).toContain("render.setResolution");
    expect(renderNodes[0]?.title).toBe("Set Render Resolution");
    expect(renderNodes[0]?.category).toBe("render");
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "res", "render.setResolution", { width: 1280, height: 720 }),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "res",
          targetPinId: "execIn",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain("ctx.setRenderResolution");
    const body = compiled.source.replace(
      /export\s+(async\s+)?function\s+/g,
      "$1function ",
    );
    const mod = new Function(`${body}\nreturn { onBeginPlay };`)() as {
      onBeginPlay: (ctx: unknown) => void;
    };
    const calls: Array<[number, number]> = [];
    mod.onBeginPlay({
      setRenderResolution: (width: number, height: number) => {
        calls.push([width, height]);
      },
    });
    expect(calls).toEqual([[1280, 720]]);
  });
});
