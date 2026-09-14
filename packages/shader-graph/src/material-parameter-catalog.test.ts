import { describe, expect, it } from "vitest";
import { normalizeMaterialParameterCatalog } from "@babylonslate/core";
import { createDefaultMaterialDocument, createDefaultMaterialFunctionDocument } from "./document";
import { buildMaterialParameterCatalog } from "./material-parameter-catalog";

function fixture() {
  const document = createDefaultMaterialDocument("Post", "postProcess");
  const fn = createDefaultMaterialFunctionDocument("Private Tint");
  fn.inputs = [];
  fn.outputs = [{ id: "out_value", name: "Result", type: "vec4" }];
  fn.nodes.push({ id: "private", type: "param.color", position: { x: 0, y: 0 },
    properties: { name: "Internal", value: [1, 1, 1, 1] } });
  fn.edges = [{ id: "private-out", sourceNodeId: "private", sourcePinId: "out",
    targetNodeId: "outputs", targetPinId: "out_value" }];
  document.nodes.push(
    { id: "tint", type: "param.color", position: { x: 0, y: 0 }, properties: { name: "Tint", value: [0.1, 0.2, 0.3, 0.4] } },
    { id: "unused", type: "param.float", position: { x: 0, y: 0 }, properties: { name: "Unused", value: [9] } },
    { id: "call", type: "function.call", position: { x: 0, y: 0 }, properties: { functionGuid: "fn" } },
    { id: "multiply", type: "math.multiply", position: { x: 0, y: 0 }, properties: {} },
  );
  document.edges = [
    { id: "tint-mul", sourceNodeId: "tint", sourcePinId: "out", targetNodeId: "multiply", targetPinId: "a" },
    { id: "call-mul", sourceNodeId: "call", sourcePinId: "out_value", targetNodeId: "multiply", targetPinId: "b" },
    { id: "mul-out", sourceNodeId: "multiply", sourcePinId: "out", targetNodeId: "output", targetPinId: "color" },
  ];
  return { document, fn };
}

describe("worker Material parameter catalog", () => {
  it("requires full function lowering and exposes only the actual root parameter bindings", () => {
    const { document, fn } = fixture();
    const documents = new Map([["post", document]]);
    expect(buildMaterialParameterCatalog(documents)).toEqual({});
    const catalog = buildMaterialParameterCatalog(documents, new Map([["fn", fn]]));
    expect(catalog.post).toMatchObject({ domain: "postProcess",
      parameters: { Tint: { kind: "color", value: [0.1, 0.2, 0.3, 0.4] } } });
    expect(Object.keys(catalog.post!.parameters)).toEqual(["Tint"]);
    expect(catalog.post!.planHash).not.toBe("");
    const copied = normalizeMaterialParameterCatalog(structuredClone(catalog));
    const color = copied.post!.parameters.Tint;
    if (color?.kind !== "color") throw new Error("Fixture has no copied color");
    color.value[0] = 0.9;
    expect(catalog.post!.parameters.Tint).toEqual({ kind: "color", value: [0.1, 0.2, 0.3, 0.4] });
    expect(document.nodes.find((node) => node.id === "tint")!.properties.value).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it("preserves typed Float/Texture defaults and rejects malformed transport domains and values", () => {
    const document = createDefaultMaterialDocument("Surface");
    document.nodes.push({ id: "rough", type: "param.float", position: { x: 0, y: 0 }, properties: { name: "Roughness", value: [0.35] } },
      { id: "image", type: "param.texture", position: { x: 0, y: 0 }, properties: { name: "Image", textureGuid: "image" } },
      { id: "sample", type: "texture.sample", position: { x: 0, y: 0 }, properties: {} });
    document.edges = document.edges.filter((edge) => !["roughness", "baseColor"].includes(edge.targetPinId));
    document.edges.push(
      { id: "rough-out", sourceNodeId: "rough", sourcePinId: "out", targetNodeId: "output", targetPinId: "roughness" },
      { id: "image-sample", sourceNodeId: "image", sourcePinId: "out", targetNodeId: "sample", targetPinId: "texture" },
      { id: "sample-out", sourceNodeId: "sample", sourcePinId: "rgb", targetNodeId: "output", targetPinId: "baseColor" });
    const catalog = buildMaterialParameterCatalog(new Map([["surface", document]]));
    expect(catalog.surface!.parameters).toEqual({ Roughness: { kind: "float", value: 0.35 }, Image: { kind: "texture", textureAssetGuid: "image" } });
    expect(normalizeMaterialParameterCatalog({
      invalid: { domain: "unknown", planHash: "x", parameters: {} },
      valid: { domain: "surface", planHash: "x", parameters: { Wrong: { kind: "float", value: NaN }, Gain: { kind: "float", value: 0.5 } } },
    })).toEqual({ valid: { domain: "surface", planHash: "x", parameters: { Gain: { kind: "float", value: 0.5 } } } });
  });
});
