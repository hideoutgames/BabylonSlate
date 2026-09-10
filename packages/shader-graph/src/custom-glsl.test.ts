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
  });

  it("rejects duplicate, reserved and nonnumeric pin interfaces", () => {
    const properties = newCustomGlslProperties();
    expect(customGlslInterfaceError(properties)).toBeNull();
    for (const name of ["B", "gl_Position", "return", "Bad Name"]) {
      expect(customGlslInterfaceError({ ...properties, inputs: [{ id: "a", name, type: "float" }, { id: "b", name: "B", type: "float" }] })).not.toBeNull();
    }
    expect(customGlslInterfaceError({ ...properties, inputs: [{ id: "a", name: "A", type: "texture" }] })).not.toBeNull();
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
