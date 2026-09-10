import { describe, expect, it } from "vitest";
import { customGlslFunctionName, materialGlslDiagnostic } from "./material-glsl-diagnostics";
import type { MaterialOperation } from "@babylonslate/shader-graph";

describe("Custom GLSL source diagnostics", () => {
  it("maps driver lines into an inlined function without colliding with sanitized node IDs", () => {
    expect(customGlslFunctionName("call/node")).not.toBe(customGlslFunctionName("call_node"));
    const operation: MaterialOperation = { id: "call/node", nodeType: "custom.glsl", resolvedType: "float", inputs: {}, properties: { body: "float x = 1.0;\nreturn Bad;" }, source: { nodeId: "node", callPath: ["call"] } };
    const effect = { vertexSourceCode: "", fragmentSourceCode: `header\n// CUSTOM_BODY_${customGlslFunctionName(operation.id)}\nfloat x = 1.0;\nreturn Bad;\n}` };
    expect(materialGlslDiagnostic("ERROR: 0:4: unknown identifier", [operation], effect)).toMatchObject({ nodeId: "call/node", line: 2, stage: "fragment" });
    expect(materialGlslDiagnostic("Link error", [operation], effect).line).toBeUndefined();
  });
});
