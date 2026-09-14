import { describe, expect, it } from "vitest";
import { createDefaultMaterialDocument, createDefaultMaterialFunctionDocument, newCustomGlslProperties } from "@babylonslate/shader-graph";
import { webGpuMaterialCompatibilityReason } from "./material-backend-compatibility";

describe("WebGPU material admission", () => {
  it("ignores disconnected custom code but reports an emitted custom contribution", () => {
    const document = createDefaultMaterialDocument("Glass");
    document.nodes.push({ id: "custom", type: "custom.glsl", position: { x: 0, y: 0 }, properties: newCustomGlslProperties() });
    const documents = new Map([["glass", document]]);
    expect(webGpuMaterialCompatibilityReason(documents, new Map())).toBeUndefined();
    document.edges.push({ id: "roughness", sourceNodeId: "custom", sourcePinId: "out", targetNodeId: "output", targetPinId: "roughness" });
    expect(webGpuMaterialCompatibilityReason(documents, new Map())).toContain('Material "Glass" uses Custom GLSL');
  });

  it("checks inlined functions without requiring a GPU or rejecting native graphs", () => {
    const document = createDefaultMaterialDocument("Function Surface");
    const fn = createDefaultMaterialFunctionDocument();
    fn.inputs = [];
    fn.nodes.push({ id: "custom", type: "custom.glsl", position: { x: 0, y: 0 }, properties: {
      ...newCustomGlslProperties(), inputs: [], outputs: [{ id: "out", name: "Result", type: "vec3" }], body: "return vec3(0.5);",
    } });
    fn.edges = [{ id: "result", sourceNodeId: "custom", sourcePinId: "out", targetNodeId: "outputs", targetPinId: "out_value" }];
    document.nodes.push({ id: "call", type: "function.call", position: { x: 0, y: 0 }, properties: { functionGuid: "fn" } });
    document.edges.push({ id: "emission", sourceNodeId: "call", sourcePinId: "out_value", targetNodeId: "output", targetPinId: "emissive" });
    expect(webGpuMaterialCompatibilityReason(new Map([["surface", document]]), new Map([["fn", fn]])))
      .toContain('Material "Function Surface" uses Custom GLSL');
    document.edges.pop();
    expect(webGpuMaterialCompatibilityReason(new Map([["surface", document]]), new Map([["fn", fn]]))).toBeUndefined();
  });
});
