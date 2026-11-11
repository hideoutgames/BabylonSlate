import { describe, expect, it } from "vitest";
import {
  createDefaultMaterialDocument,
  createDefaultMaterialFunctionDocument,
  normalizeMaterialDocument,
  type MaterialDocument,
} from "./document";
import { newCustomGlslProperties } from "./custom-glsl";
import { lowerMaterialDocument, materialCompileKeyFromLowering, MATERIAL_MAX_OPERATIONS } from "./lower";
import { isPerInstanceParameter } from "./parameters";

const materialCompileKey = (document: MaterialDocument) => materialCompileKeyFromLowering(document, lowerMaterialDocument(document));

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
  it("preserves the normal fallback through saving and invalidates both material cache keys", () => {
    const doc = createDefaultMaterialDocument();
    const model = lowerMaterialDocument(doc);
    const flatDoc = normalizeMaterialDocument(JSON.parse(JSON.stringify({ ...doc, defaultNormals: "flat" })));
    const flat = lowerMaterialDocument(flatDoc);
    expect(model.ok && flat.ok).toBe(true);
    if (!model.ok || !flat.ok) return;
    expect(model.plan.defaultNormals).toBe("model");
    expect(flat.plan.defaultNormals).toBe("flat");
    expect(flat.plan.outputs.normal).toBeNull();
    expect(flat.plan.hash).not.toBe(model.plan.hash);
    expect(materialCompileKey(flatDoc)).not.toBe(materialCompileKey(doc));
    expect(normalizeMaterialDocument({ ...doc, defaultNormals: "invalid" }).defaultNormals).toBe("model");
  });
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

  it("records an explicit conversion when a float feeds a vector pin", () => {
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
      conversions: [{ from: "float", to: "vec3" }],
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

  it.each([true, false])("preserves narrowing through nested function boundaries (wired=%s)", (wired) => {
    const inner = createDefaultMaterialFunctionDocument("Inner");
    inner.inputs[0] = { ...inner.inputs[0]!, type: "vec2", defaultValue: [0, 0] };
    inner.outputs[0]!.type = "vec4";
    const outer = createDefaultMaterialFunctionDocument("Outer");
    outer.inputs[0] = { ...outer.inputs[0]!, type: "vec4", defaultValue: [2, 3, 4, 5] };
    outer.outputs[0]!.type = "vec4";
    outer.nodes.push({ id: "inner", type: "function.call", position: { x: 0, y: 0 }, properties: { functionGuid: "inner" } });
    outer.edges = [
      { id: "in", sourceNodeId: "inputs", sourcePinId: "in_value", targetNodeId: "inner", targetPinId: "in_value" },
      { id: "out", sourceNodeId: "inner", sourcePinId: "out_value", targetNodeId: "outputs", targetPinId: "out_value" },
    ];
    const doc = createDefaultMaterialDocument("Round Trip", "postProcess");
    doc.nodes.push({ id: "call", type: "function.call", position: { x: 0, y: 0 }, properties: { functionGuid: "outer" } });
    doc.edges = [{ id: "result", sourceNodeId: "call", sourcePinId: "out_value", targetNodeId: "output", targetPinId: "color" }];
    if (wired) {
      doc.nodes.push({ id: "source", type: "const.vec4", position: { x: 0, y: 0 }, properties: { value: [2, 3, 4, 5] } });
      doc.edges.push({ id: "value", sourceNodeId: "source", sourcePinId: "out", targetNodeId: "call", targetPinId: "in_value" });
    }
    const result = lowerMaterialDocument(doc, { functions: { inner, outer } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.outputs.color).toEqual(wired ? {
      kind: "operation", operationId: "source", pinId: "out",
      conversions: [{ from: "vec4", to: "vec2" }, { from: "vec2", to: "vec4" }],
    } : { kind: "constant", type: "vec4", value: [2, 3, 1, 1] });

    inner.inputs[0]!.type = "vec3";
    const changed = lowerMaterialDocument(doc, { functions: { inner, outer } });
    expect(changed.ok).toBe(true);
    if (changed.ok) expect(changed.plan.hash).not.toBe(result.plan.hash);
  });

  it("converts declared Custom GLSL inputs independently of its output width", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({ id: "custom", type: "custom.glsl", position: { x: 0, y: 0 }, properties: {
      inputs: [{ id: "value", name: "Value", type: "vec2" }],
      outputs: [{ id: "out", name: "Out", type: "float" }],
      body: "return Value.x;",
    } });
    doc.edges = [
      { id: "in", sourceNodeId: "baseColor", sourcePinId: "out", targetNodeId: "custom", targetPinId: "value" },
      { id: "out", sourceNodeId: "custom", sourcePinId: "out", targetNodeId: "output", targetPinId: "baseColor" },
    ];
    const result = lowerMaterialDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.operations.find((operation) => operation.id === "custom")?.inputs.value).toMatchObject({ conversions: [{ from: "vec3", to: "vec2" }] });
    expect(result.plan.outputs.baseColor).toMatchObject({ conversions: [{ from: "float", to: "vec3" }] });
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

  it("compiles a parameter marked Per Instance apart from the same parameter unmarked", () => {
    const tinted = (perInstance: boolean) => {
      const doc = createDefaultMaterialDocument();
      const tint = doc.nodes.find((node) => node.id === "baseColor")!;
      tint.type = "param.color";
      tint.properties = { name: "Tint", value: [1, 1, 1, 1], perInstance };
      doc.edges.find((edge) => edge.sourceNodeId === "baseColor")!.sourcePinId = "rgb";
      return lowerMaterialDocument(doc);
    };
    const [marked, unmarked] = [tinted(true), tinted(false)];
    expect(marked.ok && unmarked.ok).toBe(true);
    if (!marked.ok || !unmarked.ok) return;
    expect(marked.plan.hash).not.toBe(unmarked.plan.hash);
    expect(isPerInstanceParameter("param.color", { perInstance: true })).toBe(true);
    expect([isPerInstanceParameter("param.texture", { perInstance: true }), isPerInstanceParameter("param.float", {})]).toEqual([false, false]);
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

  it("keys the exact alpha cutoff the compiler bakes", () => {
    const masked = (alphaCutoff: number) => ({
      ...createDefaultMaterialDocument(),
      blendMode: "masked" as const,
      alphaCutoff,
    });
    expect(materialCompileKey(masked(0.50001))).not.toBe(materialCompileKey(masked(0.50004)));
  });

  it("changes the compile key when a Custom GLSL body changes", () => {
    const withBody = (body: string) => {
      const doc = createDefaultMaterialDocument();
      doc.nodes.push({
        id: "glsl",
        type: "custom.glsl",
        position: { x: 0, y: 0 },
        properties: { ...newCustomGlslProperties(), body },
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
    expect(materialCompileKey(withBody("return A + B;"))).not.toBe(
      materialCompileKey(withBody("return A * B;")),
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
        properties: { name: "Texture", textureGuid: "tex-1" },
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

  it("omits unwired Texture Sample UV and texture pins so the compiler can attach plumbing", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({
      id: "sample",
      type: "texture.sample",
      position: { x: 0, y: 0 },
      properties: { textureGuid: "tex-inline" },
    });
    doc.edges = doc.edges.filter((edge) => edge.id !== "e-color-output");
    doc.edges.push({
      id: "e-sample",
      sourceNodeId: "sample",
      sourcePinId: "rgb",
      targetNodeId: "output",
      targetPinId: "baseColor",
    });
    const result = lowerMaterialDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sample = result.plan.operations.find(
      (operation) => operation.nodeType === "texture.sample",
    );
    expect(sample).toBeDefined();
    expect(sample?.inputs.uv).toBeUndefined();
    expect(sample?.inputs.texture).toBeUndefined();
    expect(result.plan.textures).toEqual([
      { operationId: "sample", textureGuid: "tex-inline" },
    ]);
  });

  it("binds only the wired Texture Parameter when a sample node still holds an earlier texture of its own", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(
      { id: "albedo", type: "param.texture", position: { x: 0, y: 0 }, properties: { name: "Albedo", textureGuid: "tex-wired" } },
      { id: "sample", type: "texture.sample", position: { x: 0, y: 0 }, properties: { textureGuid: "tex-stale" } },
    );
    doc.edges = doc.edges.filter((edge) => edge.id !== "e-color-output");
    doc.edges.push(
      { id: "e-texture", sourceNodeId: "albedo", sourcePinId: "out", targetNodeId: "sample", targetPinId: "texture" },
      { id: "e-sample", sourceNodeId: "sample", sourcePinId: "rgb", targetNodeId: "output", targetPinId: "baseColor" },
    );
    const result = lowerMaterialDocument(doc);
    if (!result.ok) throw new Error(result.diagnostics.map((row) => row.code).join(", "));

    expect(result.plan.textures).toEqual([{ operationId: "albedo", textureGuid: "tex-wired" }]);
    expect(result.plan.dependencies.textures).toEqual(["tex-wired"]);
  });

  it("refuses a Material whose nested functions expand past the operation limit", () => {
    const edge = (id: string, sourceNodeId: string, sourcePinId: string, targetNodeId: string, targetPinId: string) =>
      ({ id, sourceNodeId, sourcePinId, targetNodeId, targetPinId });
    /** `depth` functions, each calling the next one twice: 2^depth copies of the last. */
    const nested = (depth: number) => {
      const functions: Record<string, ReturnType<typeof createDefaultMaterialFunctionDocument>> = {};
      for (let level = 0; level < depth; level++) {
        const fn = createDefaultMaterialFunctionDocument(`Level ${level}`);
        const last = level === depth - 1;
        fn.nodes.push({ id: "mix", type: last ? "math.multiply" : "math.add", position: { x: 0, y: 0 }, properties: {} });
        if (last) {
          fn.edges = [edge("in", "inputs", "in_value", "mix", "a"), edge("out", "mix", "out", "outputs", "out_value")];
        } else {
          for (const side of ["a", "b"]) {
            fn.nodes.push({ id: side, type: "function.call", position: { x: 0, y: 0 }, properties: { functionGuid: `fn-${level + 1}` } });
          }
          fn.edges = [
            edge("in-a", "inputs", "in_value", "a", "in_value"), edge("in-b", "inputs", "in_value", "b", "in_value"),
            edge("a-mix", "a", "out_value", "mix", "a"), edge("b-mix", "b", "out_value", "mix", "b"),
            edge("out", "mix", "out", "outputs", "out_value"),
          ];
        }
        functions[`fn-${level}`] = fn;
      }
      const doc = createDefaultMaterialDocument();
      doc.nodes.push({ id: "call", type: "function.call", position: { x: 0, y: 0 }, properties: { functionGuid: "fn-0" } });
      doc.edges = doc.edges.filter((entry) => entry.id !== "e-color-output");
      doc.edges.push(edge("e-color-call", "baseColor", "out", "call", "in_value"), edge("e-call-output", "call", "out_value", "output", "baseColor"));
      return lowerMaterialDocument(doc, { functions });
    };

    const small = nested(4);
    expect(small.ok && small.plan.operations.length).toBeLessThan(MATERIAL_MAX_OPERATIONS);
    const huge = nested(14);
    expect(huge).toEqual({ ok: false, diagnostics: [expect.objectContaining({ code: "material.tooLarge", severity: "error" })] });
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

  it("emits nothing for a function input the body never reads", () => {
    const fn = createDefaultMaterialFunctionDocument("Passthrough");
    fn.inputs.push({ id: "in_unused", name: "Unused", type: "float" });
    const doc = createDefaultMaterialDocument("Fx", "postProcess");
    doc.nodes.push(
      { id: "depth", type: "input.sceneDepth", position: { x: 0, y: 0 }, properties: {} },
      { id: "call", type: "function.call", position: { x: 0, y: 0 }, properties: { functionGuid: "fn-pass" } },
    );
    doc.edges = doc.edges.filter((edge) => edge.id !== "e-scene-output");
    doc.edges.push(
      { id: "e-uv-depth", sourceNodeId: "screenUv", sourcePinId: "uv", targetNodeId: "depth", targetPinId: "uv" },
      { id: "e-depth-call", sourceNodeId: "depth", sourcePinId: "depth", targetNodeId: "call", targetPinId: "in_unused" },
      { id: "e-color-call", sourceNodeId: "sceneColor", sourcePinId: "color", targetNodeId: "call", targetPinId: "in_value" },
      { id: "e-call-out", sourceNodeId: "call", sourcePinId: "out_value", targetNodeId: "output", targetPinId: "color" },
    );
    const result = lowerMaterialDocument(doc, { functions: { "fn-pass": fn } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.operations.map((operation) => operation.nodeType)).not.toContain("input.sceneDepth");
    expect(result.plan.bufferRequirements.sceneDepth).toBe(false);
    expect(result.plan.cost.usesSceneDepth).toBe(false);
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
