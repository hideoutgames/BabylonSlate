import { describe, expect, it } from "vitest";
import { materialParameterTextureGuidsFromGraph } from "./index";
import type { SerializedGraph } from "./project";

function node(
  id: string,
  properties: Record<string, unknown>,
  type = "material.setTextureParameter",
): SerializedGraph["nodes"][number] {
  return { id, type, position: { x: 0, y: 0 }, data: { properties } };
}

describe("materialParameterTextureGuidsFromGraph", () => {
  it("collects only Texture setter values across events and functions, honoring canonical cleared defaults", () => {
    const graph: SerializedGraph = {
      nodes: [
        node("first", {
          "default:value": " texture-a ",
          "default:name": "texture-ignore",
        }),
        node("duplicate", { value: "texture-a" }),
        node(
          "wrong-type",
          { "default:value": "texture-ignore" },
          "material.setFloatParameter",
        ),
        node("cleared", {
          "default:value": null,
          "default:Value": "texture-ignore",
        }),
        node("empty", {
          "default:value": "",
          "default:Value": "texture-ignore",
        }),
        node("invalid", { "default:value": 12 }),
      ],
      edges: [],
      functionGraphs: {
        tint: {
          nodes: [
            node("legacy", { "default:Value": "texture-b" }),
            { ...node("direct", {}), data: { Value: "texture-c" } },
          ],
          edges: [],
        },
      },
    };
    expect(materialParameterTextureGuidsFromGraph(graph)).toEqual(["texture-a", "texture-b", "texture-c"]);
  });
});
