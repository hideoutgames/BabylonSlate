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
  it.each(["const.float", "const.vec2", "const.vec3"])("accepts padded channels from %s", (type) => {
    const doc = graph(type, { r: false, b: true, a: true });
    expect(validateMaterialDocument(doc)).toEqual([]);
    expect(createTypeResolver(doc).inputType("mask", "value")).toBe("vec4");
    expect(createTypeResolver(doc).outputType("mask", "out")).toBe("vec2");
  });
  it("rejects an empty mask", () => {
    expect(validateMaterialDocument(graph("const.vec4", { r: false }))).toEqual(expect.arrayContaining([expect.objectContaining({ code: "material.vectorMask", nodeId: "mask" })]));
  });
});
