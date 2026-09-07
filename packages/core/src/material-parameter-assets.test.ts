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
  it("collects typed class and function-local Texture variable defaults", () => {
    const graph: SerializedGraph = {
      nodes: [],
      edges: [],
      members: [
        { id: "albedo", kind: "variable", name: "Albedo", typeId: "asset", typeClassId: "Texture", defaultValue: " texture-class " },
        { id: "local", kind: "variable", name: "Local Texture", typeId: "asset", typeClassId: "Texture", functionId: "tint", defaultValue: "texture-local" },
        { id: "string", kind: "variable", name: "Name", typeId: "string", defaultValue: "texture-ignore" },
        { id: "audio", kind: "variable", name: "Audio", typeId: "asset", typeClassId: "Audio", defaultValue: "audio-ignore" },
        { id: "empty", kind: "variable", name: "Empty", typeId: "asset", typeClassId: "Texture", defaultValue: null },
      ],
      functionGraphs: { tint: { nodes: [], edges: [] } },
    };
    expect(materialParameterTextureGuidsFromGraph(graph)).toEqual([
      "texture-class",
      "texture-local",
    ]);
  });

  it("collects only Texture-typed entries from Array and Map variable defaults", () => {
    const graph: SerializedGraph = {
      nodes: [],
      edges: [],
      members: [
        { id: "array", kind: "variable", name: "Textures", typeId: "asset", typeClassId: "Texture", container: "array", defaultValue: ["texture-array", "texture-array", null] },
        { id: "values", kind: "variable", name: "Texture Values", typeId: "asset", typeClassId: "Texture", container: "map", keyTypeId: "string", defaultValue: [{ key: "string-key-ignore", value: "texture-value" }] },
        { id: "keys", kind: "variable", name: "Texture Keys", typeId: "string", container: "map", keyTypeId: "asset", keyTypeClassId: "Texture", defaultValue: [{ key: "texture-key", value: "string-value-ignore" }] },
        { id: "invalid", kind: "variable", name: "Invalid Array", typeId: "asset", typeClassId: "Texture", container: "array", defaultValue: "invalid-ignore" },
      ],
    };
    expect(materialParameterTextureGuidsFromGraph(graph)).toEqual([
      "texture-array",
      "texture-value",
      "texture-key",
    ]);
  });

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
