import { describe, expect, it } from "vitest";
import { createDefaultMaterialDocument, hydrateMaterialGraphForEditor, materialGraphToSerialized, validateMaterialDocument } from "./index";
import { createTypeResolver } from "./resolve";

function graph(type: string, properties: Record<string, unknown>) {
  const doc = createDefaultMaterialDocument();
  doc.nodes.push({ id: "value", type, position: { x: 0, y: 0 }, properties: { value: [1, 2, 3, 4] } }, { id: "mask", type: "vector.mask", position: { x: 0, y: 0 }, properties });
  doc.edges.push({ id: "mask-input", sourceNodeId: "value", sourcePinId: "out", targetNodeId: "mask", targetPinId: "value" });
  return doc;
}
describe("Component Mask", () => {
  it.each([[{}, "float", "X"], [{ b: true }, "vec2", "XZ"], [{ g: true, b: true }, "vec3", "XYZ"], [{ g: true, b: true, a: true }, "vec4", "XYZW"]] as const)("derives selected channels and output width: %j", (properties, kind, suffix) => {
    const doc = graph("const.vec4", properties);
    expect(createTypeResolver(doc).outputType("mask", "out")).toBe(kind);
    expect(validateMaterialDocument(doc)).toEqual([]);
    const node = hydrateMaterialGraphForEditor(materialGraphToSerialized(doc)).nodes.find((node) => node.id === "mask")!;
    expect(node.data.title).toBe(`Component Mask (${suffix})`);
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

describe("Swizzle", () => {
  function swizzle(properties: Record<string, unknown>) {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({ id: "value", type: "const.vec4", position: { x: 0, y: 0 }, properties: { value: [1, 2, 3, 4] } }, { id: "swizzle", type: "vector.swizzle", position: { x: 0, y: 0 }, properties });
    doc.edges.push({ id: "swizzle-input", sourceNodeId: "value", sourcePinId: "out", targetNodeId: "swizzle", targetPinId: "value" });
    return doc;
  }
  it.each([[{}, "vec3", "XYZ"], [{ components: "w" }, "float", "W"], [{ components: "zx" }, "vec2", "ZX"], [{ components: "ZZZZ" }, "vec4", "ZZZZ"]] as const)(
    "takes its width and title from its components in output order: %j", (properties, kind, suffix) => {
      const doc = swizzle(properties);
      expect(validateMaterialDocument(doc)).toEqual([]);
      expect(createTypeResolver(doc).outputType("swizzle", "out")).toBe(kind);
      const node = hydrateMaterialGraphForEditor(materialGraphToSerialized(doc)).nodes.find((node) => node.id === "swizzle")!;
      expect(node.data.title).toBe(`Swizzle (${suffix})`);
    });
  it.each(["", "xyzwx", "rgb", 3])("rejects components that are not one to four of X, Y, Z and W: %j", (components) => {
    expect(validateMaterialDocument(swizzle({ components }))).toEqual(expect.arrayContaining([expect.objectContaining({ code: "material.swizzle", nodeId: "swizzle" })]));
  });
});
