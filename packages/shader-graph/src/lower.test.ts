import { describe, expect, it } from "vitest";
import {
  createDefaultMaterialDocument,
  createDefaultMaterialFunctionDocument,
  type MaterialDocument,
} from "./document";
import { lowerMaterialDocument } from "./lower";

function surfaceWithMultiply(): MaterialDocument {
  const doc = createDefaultMaterialDocument();
  doc.nodes.push(
    {
      id: "tint",
      type: "const.vec3",
      position: { x: 0, y: 0 },
      properties: { value: [1, 0, 0] },
    },
    {
      id: "mul",
      type: "math.multiply",
      position: { x: 0, y: 0 },
      properties: {},
    },
  );
  doc.edges = doc.edges.filter((edge) => edge.id !== "e-rgb-output");
  doc.edges.push(
    {
      id: "e-rgb-mul",
      sourceNodeId: "rgb",
      sourcePinId: "xyz",
      targetNodeId: "mul",
      targetPinId: "a",
    },
    {
      id: "e-tint-mul",
      sourceNodeId: "tint",
      sourcePinId: "out",
      targetNodeId: "mul",
      targetPinId: "b",
    },
    {
      id: "e-mul-out",
      sourceNodeId: "mul",
      sourcePinId: "out",
      targetNodeId: "output",
      targetPinId: "baseColor",
    },
  );
  return doc;
}

describe("material lowering", () => {
  it("lowers the default surface material to a build plan", () => {
    const plan = lowerMaterialDocument(createDefaultMaterialDocument());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.plan.domain).toBe("surface");
    expect(plan.plan.outputs.baseColor).not.toBeNull();
  });

  it("refuses to lower a graph with errors", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({
      id: "bogus",
      type: "math.doesNotExist",
      position: { x: 0, y: 0 },
      properties: {},
    });
    const plan = lowerMaterialDocument(doc);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.diagnostics.some((row) => row.severity === "error")).toBe(true);
  });

  it("orders operations so every input is produced before it is consumed", () => {
    const result = lowerMaterialDocument(surfaceWithMultiply());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const seen = new Set<string>();
    for (const operation of result.plan.operations) {
      for (const operand of Object.values(operation.inputs)) {
        if (operand.kind === "operation") {
          expect(seen.has(operand.operationId)).toBe(true);
        }
      }
      seen.add(operation.id);
    }
  });

  it("records the resolved generic type on each operation", () => {
    const result = lowerMaterialDocument(surfaceWithMultiply());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const multiply = result.plan.operations.find(
      (operation) => operation.nodeType === "math.multiply",
    );
    expect(multiply?.resolvedType).toBe("vec3");
  });

  it("inserts an explicit splat when a float feeds a vector pin", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(
      {
        id: "scalar",
        type: "const.float",
        position: { x: 0, y: 0 },
        properties: { value: [0.25] },
      },
      { id: "mul", type: "math.multiply", position: { x: 0, y: 0 }, properties: {} },
    );
    doc.edges = doc.edges.filter((edge) => edge.id !== "e-rgb-output");
    doc.edges.push(
      {
        id: "e-rgb-mul",
        sourceNodeId: "rgb",
        sourcePinId: "xyz",
        targetNodeId: "mul",
        targetPinId: "a",
      },
      {
        id: "e-scalar-mul",
        sourceNodeId: "scalar",
        sourcePinId: "out",
        targetNodeId: "mul",
        targetPinId: "b",
      },
      {
        id: "e-mul-out",
        sourceNodeId: "mul",
        sourcePinId: "out",
        targetNodeId: "output",
        targetPinId: "baseColor",
      },
    );
    const result = lowerMaterialDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const multiply = result.plan.operations.find(
      (operation) => operation.nodeType === "math.multiply",
    )!;
    expect(multiply.inputs.b).toMatchObject({
      convert: { kind: "splat", to: "vec3" },
    });
  });

  it("falls back to the pin default when nothing is wired in", () => {
    const result = lowerMaterialDocument(createDefaultMaterialDocument());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.outputs.roughness).toEqual({
      kind: "constant",
      type: "float",
      value: [0.5],
    });
  });

  it("drops nodes that do not reach the output", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({
      id: "orphan",
      type: "math.sin",
      position: { x: 0, y: 0 },
      properties: {},
    });
    const result = lowerMaterialDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.plan.operations.some((operation) => operation.id === "orphan"),
    ).toBe(false);
  });

  it("produces the same hash for the same graph and a different one otherwise", () => {
    const first = lowerMaterialDocument(createDefaultMaterialDocument());
    const second = lowerMaterialDocument(createDefaultMaterialDocument());
    const changed = lowerMaterialDocument(surfaceWithMultiply());
    expect(first.ok && second.ok && changed.ok).toBe(true);
    if (!first.ok || !second.ok || !changed.ok) return;
    expect(first.plan.hash).toBe(second.plan.hash);
    expect(first.plan.hash).not.toBe(changed.plan.hash);
  });

  it("ignores node positions in the hash", () => {
    const a = createDefaultMaterialDocument();
    const b = createDefaultMaterialDocument();
    b.nodes[0]!.position = { x: 999, y: -42 };
    const first = lowerMaterialDocument(a);
    const second = lowerMaterialDocument(b);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.plan.hash).toBe(second.plan.hash);
  });

  it("counts texture samples and cost for the preview policy", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(
      {
        id: "tex",
        type: "param.texture",
        position: { x: 0, y: 0 },
        properties: { textureGuid: "tex-1" },
      },
      { id: "uv", type: "input.uv", position: { x: 0, y: 0 }, properties: {} },
      {
        id: "sample",
        type: "texture.sample",
        position: { x: 0, y: 0 },
        properties: {},
      },
    );
    doc.edges = doc.edges.filter((edge) => edge.id !== "e-rgb-output");
    doc.edges.push(
      {
        id: "e-tex",
        sourceNodeId: "tex",
        sourcePinId: "out",
        targetNodeId: "sample",
        targetPinId: "texture",
      },
      {
        id: "e-uv",
        sourceNodeId: "uv",
        sourcePinId: "uv",
        targetNodeId: "sample",
        targetPinId: "uv",
      },
      {
        id: "e-sample",
        sourceNodeId: "sample",
        sourcePinId: "rgb",
        targetNodeId: "output",
        targetPinId: "baseColor",
      },
    );
    const result = lowerMaterialDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.cost.textureSamples).toBe(1);
    expect(result.plan.cost.operations).toBeGreaterThan(0);
    expect(result.plan.textures).toEqual([
      { operationId: "tex", textureGuid: "tex-1" },
    ]);
  });

  it("inlines a material function call with namespaced operation ids", () => {
    const fn = createDefaultMaterialFunctionDocument("Tint");
    fn.nodes.push({
      id: "boost",
      type: "math.multiply",
      position: { x: 0, y: 0 },
      properties: {},
    });
    fn.edges = [
      {
        id: "e-in-boost",
        sourceNodeId: "inputs",
        sourcePinId: "in_value",
        targetNodeId: "boost",
        targetPinId: "a",
      },
      {
        id: "e-boost-out",
        sourceNodeId: "boost",
        sourcePinId: "out",
        targetNodeId: "outputs",
        targetPinId: "out_value",
      },
    ];

    const doc = createDefaultMaterialDocument();
    doc.nodes.push({
      id: "call",
      type: "function.call",
      position: { x: 0, y: 0 },
      properties: { functionGuid: "fn-tint" },
    });
    doc.edges = doc.edges.filter((edge) => edge.id !== "e-rgb-output");
    doc.edges.push(
      {
        id: "e-rgb-call",
        sourceNodeId: "rgb",
        sourcePinId: "xyz",
        targetNodeId: "call",
        targetPinId: "in_value",
      },
      {
        id: "e-call-out",
        sourceNodeId: "call",
        sourcePinId: "out_value",
        targetNodeId: "output",
        targetPinId: "baseColor",
      },
    );

    const result = lowerMaterialDocument(doc, {
      functions: { "fn-tint": fn },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.plan.operations.some((operation) => operation.id === "call/boost"),
    ).toBe(true);
    expect(
      result.plan.operations.some(
        (operation) => operation.nodeType === "function.call",
      ),
    ).toBe(false);
    expect(result.plan.dependencies.functions).toEqual(["fn-tint"]);
  });

  it("maps an inlined operation back to its function and call node", () => {
    const fn = createDefaultMaterialFunctionDocument("Tint");
    fn.nodes.push({
      id: "boost",
      type: "math.multiply",
      position: { x: 0, y: 0 },
      properties: {},
    });
    fn.edges = [
      {
        id: "e-in-boost",
        sourceNodeId: "inputs",
        sourcePinId: "in_value",
        targetNodeId: "boost",
        targetPinId: "a",
      },
      {
        id: "e-boost-out",
        sourceNodeId: "boost",
        sourcePinId: "out",
        targetNodeId: "outputs",
        targetPinId: "out_value",
      },
    ];
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({
      id: "call",
      type: "function.call",
      position: { x: 0, y: 0 },
      properties: { functionGuid: "fn-tint" },
    });
    doc.edges = doc.edges.filter((edge) => edge.id !== "e-rgb-output");
    doc.edges.push(
      {
        id: "e-rgb-call",
        sourceNodeId: "rgb",
        sourcePinId: "xyz",
        targetNodeId: "call",
        targetPinId: "in_value",
      },
      {
        id: "e-call-out",
        sourceNodeId: "call",
        sourcePinId: "out_value",
        targetNodeId: "output",
        targetPinId: "baseColor",
      },
    );
    const result = lowerMaterialDocument(doc, { functions: { "fn-tint": fn } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const inlined = result.plan.operations.find((operation) =>
      operation.id.startsWith("call/"),
    );
    expect(inlined?.source.callPath).toEqual(["call"]);
    expect(inlined?.source.functionGuid).toBe("fn-tint");
  });
});
