import { describe, expect, it } from "vitest";
import {
  compileGraph,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry, sceneNodes } from "./index";

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

describe("scene nodes", () => {
  it("exports Change Scene with a Scene assetRef pin", () => {
    expect(sceneNodes.length).toBeGreaterThan(0);
    expect(sceneNodes[0]?.id).toBe("scene.change");
    expect(sceneNodes[0]?.category).toBe("scene");
    const scenePin = sceneNodes[0]?.pins({}).find((pin) => pin.id === "scene");
    expect(scenePin?.type).toEqual({ kind: "assetRef", assetType: "Scene" });
  });

  it("compiled Change Scene calls ctx.changeScene with the Scene guid", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "change", "scene.change", {
          "default:scene": "scene-level-2",
        }),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "change",
          targetPinId: "execIn",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain("ctx.changeScene");
    const body = compiled.source.replace(
      /export\s+(async\s+)?function\s+/g,
      "$1function ",
    );
    const mod = new Function(`${body}\nreturn { onBeginPlay };`)() as {
      onBeginPlay: (ctx: unknown) => void;
    };
    const scenes: string[] = [];
    mod.onBeginPlay({
      changeScene: (scene: string) => {
        scenes.push(scene);
      },
    });
    expect(scenes).toEqual(["scene-level-2"]);
  });
});
