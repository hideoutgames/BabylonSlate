import { describe, expect, it } from "vitest";
import type { MaterialGraphEdge, MaterialGraphNode } from "./document";
import {
  convertMaterialConstantToParameter,
  convertMaterialParameterToConstant,
  nameNewMaterialParameters,
  renameMaterialParameter,
  retypeMaterialParameter,
  uniqueMaterialParameterName,
} from "./parameter-authoring";

const node = (id: string, type: string, properties: Record<string, unknown> = {}): MaterialGraphNode =>
  ({ id, type, position: { x: 0, y: 0 }, properties });
const edge = (id: string, sourceNodeId: string, sourcePinId: string): MaterialGraphEdge =>
  ({ id, sourceNodeId, sourcePinId, targetNodeId: "output", targetPinId: "baseColor" });

describe("material parameter authoring", () => {
  it("gives added and pasted parameters free names and keeps existing ones", () => {
    const previous = [node("tint", "param.color", { name: "Tint", value: [1, 1, 1, 1] })];
    const next = nameNewMaterialParameters(previous, [
      ...previous,
      node("copy", "param.color", { name: "Tint", value: [1, 1, 1, 1] }),
      node("fresh", "param.float", { name: "", value: [0] }),
      node("fresh-2", "param.vec2", { name: "", value: [0, 0] }),
      node("math", "math.add"),
    ]);
    expect(next.map((entry) => entry.properties.name)).toEqual(["Tint", "Tint_1", "Parameter", "Parameter_1", undefined]);
    expect(uniqueMaterialParameterName(next, "Tint_1")).toBe("Tint_2");
    expect(renameMaterialParameter({ nodes: next, edges: [] }, "fresh", "Tint").nodes[2]!.properties.name).toBe("Tint_2");
    expect(renameMaterialParameter({ nodes: next, edges: [] }, "copy", "Tint_1").nodes[1]!.properties.name).toBe("Tint_1");
  });

  it("converts a Color Constant to a parameter and back, moving its wires between RGB and the Constant", () => {
    const doc = { nodes: [node("base", "const.color", { value: [0.2, 0.4, 0.6] })], edges: [edge("e", "base", "out")] };
    const parameter = convertMaterialConstantToParameter(doc, "base")!;
    expect(parameter.nodes[0]).toMatchObject({ type: "param.color", properties: { name: "Parameter", value: [0.2, 0.4, 0.6, 1] } });
    expect(parameter.edges[0]!.sourcePinId).toBe("rgb");
    const back = convertMaterialParameterToConstant(parameter, "base")!;
    expect(back.nodes[0]).toMatchObject({ type: "const.color", properties: { value: [0.2, 0.4, 0.6] } });
    expect(back.edges[0]!.sourcePinId).toBe("out");
    expect(convertMaterialConstantToParameter(doc, "missing")).toBeNull();
    expect(convertMaterialParameterToConstant({ nodes: [node("t", "param.texture", { name: "T" })], edges: [] }, "t")).toBeNull();
  });

  it("converts vectors keeping their value and wires", () => {
    const doc = { nodes: [node("v", "const.vec3", { value: [1, 2, 3] })], edges: [edge("e", "v", "out")] };
    const parameter = convertMaterialConstantToParameter(doc, "v")!;
    expect(parameter.nodes[0]).toMatchObject({ type: "param.vec3", properties: { value: [1, 2, 3] } });
    expect(parameter.edges).toEqual(doc.edges);
    // A Vector4 Constant becomes a Vector4 Parameter, not a Color: its four values stay raw numbers.
    const four = { nodes: [node("v", "const.vec4", { value: [1, 2, 3, 4] })], edges: [edge("e", "v", "out")] };
    const raw = convertMaterialConstantToParameter(four, "v")!;
    expect(raw.nodes[0]).toMatchObject({ type: "param.vec4", properties: { value: [1, 2, 3, 4] } });
    expect(convertMaterialParameterToConstant(raw, "v")!.nodes[0]).toMatchObject({ type: "const.vec4", properties: { value: [1, 2, 3, 4] } });
  });

  it("retypes a parameter, resizing its default and dropping wires the new type cannot carry", () => {
    const doc = {
      nodes: [node("p", "param.color", { name: "Tint", value: [0.5, 0.5, 0.5, 1] })],
      edges: [edge("rgba", "p", "out"), edge("rgb", "p", "rgb")],
    };
    // To a Vector4: the four components stay, and the Color-only RGB and A wires go.
    const four = retypeMaterialParameter({ ...doc, edges: [...doc.edges, edge("alpha", "p", "a")] }, "p", "vec4");
    expect(four.nodes[0]).toMatchObject({ type: "param.vec4", properties: { name: "Tint", value: [0.5, 0.5, 0.5, 1] } });
    expect(four.edges.map((entry) => entry.id)).toEqual(["rgba"]);
    const vector = retypeMaterialParameter(doc, "p", "vec2");
    expect(vector.nodes[0]).toMatchObject({ type: "param.vec2", properties: { name: "Tint", value: [0.5, 0.5] } });
    expect(vector.edges.map((entry) => entry.id)).toEqual(["rgba"]);
    const texture = retypeMaterialParameter(vector, "p", "texture");
    expect(texture.nodes[0]).toMatchObject({ type: "param.texture", properties: { name: "Tint", textureGuid: null } });
    expect(texture.edges).toEqual([]);
    expect(retypeMaterialParameter(doc, "p", "color")).toBe(doc);
    const color = retypeMaterialParameter({ nodes: [node("f", "param.float", { name: "F", value: [0.25] })], edges: [] }, "f", "color");
    expect(color.nodes[0]!.properties.value).toEqual([0.25, 0.25, 0.25, 1]);
  });
});
