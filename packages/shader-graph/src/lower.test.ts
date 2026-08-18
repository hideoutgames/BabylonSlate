import { describe, expect, it } from "vitest";
import {
  createDefaultMaterialDocument,
  createDefaultMaterialFunctionDocument,
  type MaterialDocument,
} from "./document";
import { lowerMaterialDocument, materialCompileKey } from "./lower";

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
  doc.edges = doc.edges.filter((edge) => edge.id !== "e-color-output");
  doc.edges.push(
    {
      id: "e-color-mul",
      sourceNodeId: "baseColor",
      sourcePinId: "out",
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

  it("lowers an interface material to Color and Opacity channels", () => {
    const result = lowerMaterialDocument(
      createDefaultMaterialDocument("HudGlow", "interface"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.domain).toBe("interface");
    expect(result.plan.outputs.color).not.toBeNull();
    expect(result.plan.outputs.opacity).not.toBeNull();
    expect(result.plan.bufferRequirements).toEqual({
      sceneColor: false,
      sceneDepth: false,
      sceneNormal: false,
    });
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
    doc.edges = doc.edges.filter((edge) => edge.id !== "e-color-output");
    doc.edges.push(
      {
        id: "e-color-mul",
        sourceNodeId: "baseColor",
        sourcePinId: "out",
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
    expect(result.plan.outputs.worldPositionOffset).toEqual({
      kind: "constant",
      type: "vec3",
      value: [0, 0, 0],
    });
  });

  it("prefers an authored default:pinId over the catalog default", () => {
    const doc = createDefaultMaterialDocument();
    const output = doc.nodes.find((node) => node.type === "output.surface");
    expect(output).toBeDefined();
    output!.properties = { "default:roughness": [0.8] };
    const result = lowerMaterialDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.outputs.roughness).toEqual({
      kind: "constant",
      type: "float",
      value: [0.8],
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

  it("keeps the compile key stable when only node positions change", () => {
    const a = createDefaultMaterialDocument();
    const b = createDefaultMaterialDocument();
    b.nodes[0]!.position = { x: 999, y: -42 };
    expect(materialCompileKey(a)).toBe(materialCompileKey(b));
  });

  it("changes the compile key when a node property changes", () => {
    const a = createDefaultMaterialDocument();
    const b = createDefaultMaterialDocument();
    const color = b.nodes.find((node) => node.type === "const.color");
    expect(color).toBeDefined();
    color!.properties = { value: [1, 0, 0, 1] };
    expect(materialCompileKey(a)).not.toBe(materialCompileKey(b));
  });

  it("changes the compile key when a Custom GLSL body changes", () => {
    const withBody = (body: string) => {
      const doc = createDefaultMaterialDocument();
      doc.nodes.push({
        id: "glsl",
        type: "custom.glsl",
        position: { x: 0, y: 0 },
        properties: { body },
      });
      doc.edges = doc.edges.filter((edge) => edge.id !== "e-color-output");
      doc.edges.push(
        {
          id: "e-color-a",
          sourceNodeId: "baseColor",
          sourcePinId: "out",
          targetNodeId: "glsl",
          targetPinId: "a",
        },
        {
          id: "e-glsl-out",
          sourceNodeId: "glsl",
          sourcePinId: "out",
          targetNodeId: "output",
          targetPinId: "baseColor",
        },
      );
      return doc;
    };
    expect(materialCompileKey(withBody("a + b"))).not.toBe(
      materialCompileKey(withBody("a * b")),
    );
  });

  it("keeps an invalid compile key stable across position-only edits", () => {
    const a = createDefaultMaterialDocument();
    a.nodes.push({
      id: "bogus",
      type: "math.doesNotExist",
      position: { x: 0, y: 0 },
      properties: {},
    });
    const b = createDefaultMaterialDocument();
    b.nodes.push({
      id: "bogus",
      type: "math.doesNotExist",
      position: { x: 40, y: 80 },
      properties: {},
    });
    expect(materialCompileKey(a)).toBe(materialCompileKey(b));
    expect(materialCompileKey(a).startsWith("invalid:")).toBe(true);
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
    doc.edges = doc.edges.filter((edge) => edge.id !== "e-color-output");
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

  it("binds an inline Texture asset on a sample node", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(
      { id: "uv", type: "input.uv", position: { x: 0, y: 0 }, properties: {} },
      {
        id: "sample",
        type: "texture.sample",
        position: { x: 0, y: 0 },
        properties: { textureGuid: "tex-inline" },
      },
    );
    doc.edges = doc.edges.filter((edge) => edge.id !== "e-color-output");
    doc.edges.push(
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
    expect(result.plan.textures).toEqual([
      { operationId: "sample", textureGuid: "tex-inline" },
    ]);
    expect(result.plan.dependencies.textures).toEqual(["tex-inline"]);
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
    doc.edges = doc.edges.filter((edge) => edge.id !== "e-color-output");
    doc.edges.push(
      {
        id: "e-color-call",
        sourceNodeId: "baseColor",
        sourcePinId: "out",
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
    doc.edges = doc.edges.filter((edge) => edge.id !== "e-color-output");
    doc.edges.push(
      {
        id: "e-color-call",
        sourceNodeId: "baseColor",
        sourcePinId: "out",
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

  it("records scene color, depth, and normal buffer requirements", () => {
    const color = lowerMaterialDocument(
      createDefaultMaterialDocument("Blur", "postProcess"),
    );
    expect(color.ok).toBe(true);
    if (!color.ok) return;
    expect(color.plan.bufferRequirements).toEqual({
      sceneColor: true,
      sceneDepth: false,
      sceneNormal: false,
    });
    expect(color.plan.cost.usesSceneDepth).toBe(false);
    expect(color.plan.cost.usesSceneNormal).toBe(false);

    const depth = lowerMaterialDocument(postProcessSampling("input.sceneDepth"));
    expect(depth.ok).toBe(true);
    if (!depth.ok) return;
    expect(depth.plan.bufferRequirements.sceneDepth).toBe(true);
    expect(depth.plan.cost.usesSceneDepth).toBe(true);

    const normal = lowerMaterialDocument(postProcessSampling("input.sceneNormal"));
    expect(normal.ok).toBe(true);
    if (!normal.ok) return;
    expect(normal.plan.bufferRequirements.sceneNormal).toBe(true);
    expect(normal.plan.cost.usesSceneNormal).toBe(true);
  });
});

function postProcessSampling(
  type: "input.sceneDepth" | "input.sceneNormal",
): MaterialDocument {
  const doc = createDefaultMaterialDocument("Fx", "postProcess");
  const outputPin = type === "input.sceneDepth" ? "depth" : "normal";
  const scaleFrom = type === "input.sceneNormal" ? "len" : "extra";
  const scalePin = type === "input.sceneNormal" ? "out" : outputPin;
  doc.nodes.push(
    { id: "extra", type, position: { x: 0, y: 0 }, properties: {} },
    { id: "mul", type: "math.multiply", position: { x: 0, y: 0 }, properties: {} },
  );
  if (type === "input.sceneNormal") {
    doc.nodes.push({
      id: "len",
      type: "vector.length",
      position: { x: 0, y: 0 },
      properties: {},
    });
  }
  doc.edges.push(
    {
      id: "e-uv-extra",
      sourceNodeId: "screenUv",
      sourcePinId: "uv",
      targetNodeId: "extra",
      targetPinId: "uv",
    },
    {
      id: "e-color-mul",
      sourceNodeId: "sceneColor",
      sourcePinId: "color",
      targetNodeId: "mul",
      targetPinId: "a",
    },
    {
      id: "e-extra-mul",
      sourceNodeId: scaleFrom,
      sourcePinId: scalePin,
      targetNodeId: "mul",
      targetPinId: "b",
    },
  );
  if (type === "input.sceneNormal") {
    doc.edges.push({
      id: "e-normal-len",
      sourceNodeId: "extra",
      sourcePinId: "normal",
      targetNodeId: "len",
      targetPinId: "value",
    });
  }
  doc.edges = doc.edges.map((edge) =>
    edge.id === "e-scene-output"
      ? { ...edge, sourceNodeId: "mul", sourcePinId: "out" }
      : edge,
  );
  return doc;
}
