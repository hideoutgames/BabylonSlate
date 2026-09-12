import { describe, expect, it } from "vitest";
import { createDefaultMaterialDocument } from "./document";
import { newCustomGlslProperties, customGlslFunctionBodyError, customGlslInterfaceError } from "./custom-glsl";
import { validateMaterialDocument } from "./validate";
import { createTypeResolver } from "./resolve";

describe("Custom GLSL function bodies", () => {
  it("permits control flow and comments but rejects escaping the generated function", () => {
    expect(customGlslFunctionBodyError("// uniform gl_FragColor\nif (A > 0.0) { return A; } return B;")).toBeNull();
    expect(customGlslFunctionBodyError("return A; } void escape() {")).not.toBeNull();
    expect(customGlslFunctionBodyError("uniform float x; return x;")).not.toBeNull();
    expect(customGlslFunctionBodyError("return texture2D(samplerImage, vec2(0.5));")).toBeNull();
    expect(customGlslFunctionBodyError("sampler2D local; return texture2D(local, vec2(0.5));")).not.toBeNull();
  });

  it("rejects duplicate, reserved and texture output pin interfaces", () => {
    const properties = newCustomGlslProperties();
    expect(customGlslInterfaceError(properties)).toBeNull();
    for (const name of ["B", "gl_Position", "return", "Bad Name"]) {
      expect(customGlslInterfaceError({ ...properties, inputs: [{ id: "a", name, type: "float" }, { id: "b", name: "B", type: "float" }] })).not.toBeNull();
    }
    expect(customGlslInterfaceError({ ...properties, inputs: [{ id: "a", name: "A", type: "texture" }] })).toBeNull();
    expect(customGlslInterfaceError({ ...properties, outputs: [{ id: "out", name: "Result", type: "texture" }] })).not.toBeNull();
  });

  it("requires a wired sampler and resolves Texture Sample's raw texture output", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({ id: "custom", type: "custom.glsl", position: { x: 0, y: 0 }, properties: {
      ...newCustomGlslProperties(), inputs: [{ id: "tex", name: "Albedo", type: "texture" }], body: "return texture2D(Albedo, vec2(0.5)).r;",
    } });
    expect(validateMaterialDocument(doc)).toEqual(expect.arrayContaining([expect.objectContaining({ code: "material.missingInput", nodeId: "custom", pinId: "tex" })]));
    doc.nodes.push({ id: "sample", type: "texture.sample", position: { x: 0, y: 0 }, properties: { textureGuid: "image" } });
    doc.edges.push({ id: "sampler", sourceNodeId: "sample", sourcePinId: "textureOut", targetNodeId: "custom", targetPinId: "tex" });
    expect(createTypeResolver(doc).outputType("sample", "textureOut")).toBe("texture");
    expect(validateMaterialDocument(doc).filter((d) => d.severity === "error")).toEqual([]);
  });

  it("resolves declared output widths and reports derivatives feeding vertex displacement", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({ id: "custom", type: "custom.glsl", position: { x: 0, y: 0 }, properties: {
      ...newCustomGlslProperties(), outputs: [{ id: "out", name: "Result", type: "vec3" }], body: "return vec3(dFdx(A));",
    } });
    doc.edges.push({ id: "offset", sourceNodeId: "custom", sourcePinId: "out", targetNodeId: "output", targetPinId: "worldPositionOffset" });
    expect(createTypeResolver(doc).outputType("custom", "out")).toBe("vec3");
    expect(validateMaterialDocument(doc)).toEqual(expect.arrayContaining([expect.objectContaining({ code: "material.stageMismatch", nodeId: "custom" })]));
  });
});
