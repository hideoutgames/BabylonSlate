import { describe, expect, it } from "vitest";
import {
  createDefaultMaterialDocument,
  createDefaultMaterialFunctionDocument,
} from "./document";
import { resolveBakeDiffuseClosure } from "./bake-material";

function material() {
  const doc = createDefaultMaterialDocument();
  doc.twoSided = true;
  doc.nodes[0].properties.value = [0.1, 0.3, 0.7];
  return doc;
}

describe("bake diffuse material closure", () => {
  it.each([
    ["const.float", [0.2], [0.2, 0, 0]],
    ["const.vec2", [0.2, 0.4], [0.2, 0.4, 0]],
    ["const.vec4", [0.2, 0.4, 0.6, 0], [0.2, 0.4, 0.6]],
  ] as const)("bakes %s into RGB using numeric input conversion", (type, value, expected) => {
    const doc = material();
    doc.nodes[0]!.type = type;
    doc.nodes[0]!.properties.value = [...value];
    doc.edges.push({ id: "emission", sourceNodeId: "baseColor", sourcePinId: "out", targetNodeId: "output", targetPinId: "emissive" });
    const closure = resolveBakeDiffuseClosure(doc);
    expect(closure.albedo).toEqual(expected);
    expect(closure.emission).toEqual(expected);
  });

  it("does not recover discarded channels when a function widens its input", () => {
    const doc = material();
    doc.nodes[0]!.type = "const.vec4";
    doc.nodes[0]!.properties.value = [0.2, 0.4, 0.6, 0.8];
    const fn = createDefaultMaterialFunctionDocument();
    fn.inputs[0] = { ...fn.inputs[0]!, type: "vec2", defaultValue: [0, 0] };
    fn.outputs[0]!.type = "vec4";
    doc.nodes.push({ id: "call", type: "function.call", position: { x: 0, y: 0 }, properties: { functionGuid: "resize" } });
    doc.edges = [
      { id: "in", sourceNodeId: "baseColor", sourcePinId: "out", targetNodeId: "call", targetPinId: "in_value" },
      { id: "out", sourceNodeId: "call", sourcePinId: "out_value", targetNodeId: "output", targetPinId: "baseColor" },
    ];
    expect(resolveBakeDiffuseClosure(doc, { functions: { resize: fn } }).albedo).toEqual([0.2, 0.4, 0]);
  });

  it("uses constant authored albedo once and includes resolved function content in provenance", () => {
    const doc = material();
    const fn = createDefaultMaterialFunctionDocument();
    doc.nodes.push({
      id: "call",
      type: "function.call",
      position: { x: 0, y: 0 },
      properties: { functionGuid: "function-1" },
    });
    doc.edges = [
      {
        id: "input",
        sourceNodeId: "baseColor",
        sourcePinId: "out",
        targetNodeId: "call",
        targetPinId: "in_value",
      },
      {
        id: "output",
        sourceNodeId: "call",
        sourcePinId: "out_value",
        targetNodeId: "output",
        targetPinId: "baseColor",
      },
    ];
    const closure = resolveBakeDiffuseClosure(doc, {
      functions: { "function-1": fn },
    });
    expect(closure.albedo).toEqual([0.1, 0.3, 0.7]);
    expect(closure.emission).toEqual([0, 0, 0]);
    expect(closure.dependencies).toContain("function-1");
    const capturedPlan = structuredClone(closure.resolvedPlan);
    const changed = structuredClone(doc);
    changed.nodes[0].properties.value = [0.2, 0.3, 0.7];
    expect(
      resolveBakeDiffuseClosure(changed, { functions: { "function-1": fn } })
        .planHash,
    ).not.toBe(closure.planHash);
    fn.nodes.push({
      id: "clock",
      type: "input.time",
      position: { x: 0, y: 0 },
      properties: {},
    });
    fn.edges = [
      {
        id: "time",
        sourceNodeId: "clock",
        sourcePinId: "time",
        targetNodeId: "outputs",
        targetPinId: "out_value",
      },
    ];
    expect(closure.resolvedPlan).toEqual(capturedPlan);
    expect(() =>
      resolveBakeDiffuseClosure(doc, { functions: { "function-1": fn } }),
    ).toThrow("clock");
  });

  it("rejects unsupported sidedness, deformation and dynamic material nodes", () => {
    const sided = material();
    sided.twoSided = false;
    expect(() => resolveBakeDiffuseClosure(sided)).toThrow("two-sided");
    const deform = material();
    deform.edges.push({
      id: "deform",
      sourceNodeId: "baseColor",
      sourcePinId: "out",
      targetNodeId: "output",
      targetPinId: "worldPositionOffset",
    });
    expect(() => resolveBakeDiffuseClosure(deform)).toThrow(
      "worldPositionOffset",
    );
    const dynamic = material();
    dynamic.nodes[0].type = "param.color";
    dynamic.nodes[0].properties = { name: "Tint", value: [0.1, 0.3, 0.7, 1] };
    dynamic.edges[0].sourcePinId = "rgb";
    expect(() => resolveBakeDiffuseClosure(dynamic)).toThrow("param.color");
  });
});
