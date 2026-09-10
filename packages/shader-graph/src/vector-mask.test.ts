import { describe, expect, it } from "vitest";
import { createDefaultMaterialDocument, createTypeResolver, hydrateMaterialGraphForEditor, materialGraphToSerialized, validateMaterialDocument } from "./index";

function graph(type: string, properties: Record<string, unknown>) {
  const doc = createDefaultMaterialDocument();
  doc.nodes.push({ id: "value", type, position: { x: 0, y: 0 }, properties: { value: [1, 2, 3, 4] } }, { id: "mask", type: "vector.mask", position: { x: 0, y: 0 }, properties });
  doc.edges.push({ id: "mask-input", sourceNodeId: "value", sourcePinId: "out", targetNodeId: "mask", targetPinId: "value" });
  return doc;
}
describe("VectorMask", () => {
  it.each([[{}, "float", "R"], [{ b: true }, "vec2", "RB"], [{ g: true, b: true }, "vec3", "RGB"], [{ g: true, b: true, a: true }, "vec4", "RGBA"]] as const)("derives selected channels and output width: %j", (properties, kind, suffix) => {
    const doc = graph("const.vec4", properties);
    expect(createTypeResolver(doc).outputType("mask", "out")).toBe(kind);
    expect(validateMaterialDocument(doc)).toEqual([]);
    const node = hydrateMaterialGraphForEditor(materialGraphToSerialized(doc)).nodes.find((node) => node.id === "mask")!;
    expect(node.data.title).toBe(`VectorMask(${suffix})`);
  });
  it.each([["const.vec2", { r: false, b: true, a: true }], ["const.vec3", { a: true }], ["const.float", {}], ["const.vec4", { r: false }]] as const)("rejects missing channels or an empty mask: %s %j", (type, properties) => {
    expect(validateMaterialDocument(graph(type, properties))).toEqual(expect.arrayContaining([expect.objectContaining({ code: "material.vectorMask", nodeId: "mask" })]));
  });
});
