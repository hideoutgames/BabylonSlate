import { describe, expect, it } from "vitest";
import {
  createDefaultMaterialDocument,
  createDefaultMaterialFunctionDocument,
  type MaterialDocument,
  type MaterialFunctionDocument,
} from "./document";
import { newCustomGlslProperties } from "./custom-glsl";
import { collectFunctionDependencies, validateMaterialDocument, validateMaterialFunctionDocument } from "./validate";

function codes(doc: MaterialDocument, context = {}): string[] {
  return validateMaterialDocument(doc, context).map((row) => row.code);
}

describe("material validation", () => {
  it("requires nonblank names on every parameter even when it is unconnected", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(...["float", "color", "texture"].map((type) => ({
      id: type, type: `param.${type}`, position: { x: 0, y: 0 }, properties: { name: "   " },
    })));
    expect(validateMaterialDocument(doc).filter((row) => row.code === "material.parameter.missingName").map((row) => row.nodeId)).toEqual(["float", "color", "texture"]);
  });

  it("rejects duplicate parameter names across value types after trimming", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(...["float", "color"].map((type) => ({
      id: type, type: `param.${type}`, position: { x: 0, y: 0 }, properties: { name: type === "float" ? "Tint" : " Tint " },
    })));
    expect(validateMaterialDocument(doc).filter((row) => row.code === "material.parameter.duplicateName").map((row) => row.nodeId)).toEqual(["float", "color"]);
  });
  it("accepts the default surface material", () => {
    expect(validateMaterialDocument(createDefaultMaterialDocument())).toEqual(
      [],
    );
  });

  it("accepts the default post-process material", () => {
    const doc = createDefaultMaterialDocument("Blur", "postProcess");
    expect(validateMaterialDocument(doc)).toEqual([]);
  });

  it("accepts the default particle material", () => {
    expect(
      validateMaterialDocument(
        createDefaultMaterialDocument("Sparks", "particle"),
      ),
    ).toEqual([]);
  });

  it("flags an unknown node type", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({
      id: "bogus",
      type: "math.doesNotExist",
      position: { x: 0, y: 0 },
      properties: {},
    });
    expect(codes(doc)).toContain("material.unknownNode");
  });

  it("reports a removed Particle Texture node on its own node and validates the rest", () => {
    const doc = createDefaultMaterialDocument("Sparks", "particle");
    doc.nodes.push({ id: "legacyTexture", type: "input.particleTexture", position: { x: 0, y: 80 }, properties: {} });
    doc.edges = [{ id: "legacy", sourceNodeId: "legacyTexture", sourcePinId: "rgba", targetNodeId: "output", targetPinId: "color" }];
    expect(validateMaterialDocument(doc)).toEqual([
      expect.objectContaining({ code: "material.unknownNode", severity: "error", nodeId: "legacyTexture" }),
    ]);
  });

  it("flags an edge that points at a missing node", () => {
    const doc = createDefaultMaterialDocument();
    doc.edges.push({
      id: "ghost",
      sourceNodeId: "missing",
      sourcePinId: "out",
      targetNodeId: "output",
      targetPinId: "baseColor",
    });
    expect(codes(doc)).toContain("material.danglingEdge");
  });

  it("flags an edge that points at a missing pin", () => {
    const doc = createDefaultMaterialDocument();
    doc.edges.push({
      id: "bad-pin",
      sourceNodeId: "baseColor",
      sourcePinId: "nope",
      targetNodeId: "output",
      targetPinId: "baseColor",
    });
    expect(codes(doc)).toContain("material.unknownPin");
  });

  it("accepts a wider vector at a narrower material input", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({
      id: "wide",
      type: "const.vec4",
      position: { x: 0, y: 0 },
      properties: {},
    });
    doc.edges = doc.edges.filter((edge) => edge.id !== "e-color-output");
    doc.edges.push({
      id: "too-wide",
      sourceNodeId: "wide",
      sourcePinId: "out",
      targetNodeId: "output",
      targetPinId: "baseColor",
    });
    expect(validateMaterialDocument(doc)).toEqual([]);
  });

  it("allows a float to widen into a vector pin", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({
      id: "scalar",
      type: "const.float",
      position: { x: 0, y: 0 },
      properties: { value: [0.5] },
    });
    doc.edges.push({
      id: "widen",
      sourceNodeId: "scalar",
      sourcePinId: "out",
      targetNodeId: "output",
      targetPinId: "emissive",
    });
    expect(codes(doc)).not.toContain("material.typeMismatch");
  });

  it("accepts generic numeric inputs with different widths", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(
      {
        id: "v2",
        type: "const.vec2",
        position: { x: 0, y: 0 },
        properties: {},
      },
      {
        id: "v3",
        type: "const.vec3",
        position: { x: 0, y: 0 },
        properties: {},
      },
      { id: "add", type: "math.add", position: { x: 0, y: 0 }, properties: {} },
    );
    doc.edges.push(
      {
        id: "a",
        sourceNodeId: "v2",
        sourcePinId: "out",
        targetNodeId: "add",
        targetPinId: "a",
      },
      {
        id: "b",
        sourceNodeId: "v3",
        sourcePinId: "out",
        targetNodeId: "add",
        targetPinId: "b",
      },
    );
    expect(validateMaterialDocument(doc)).toEqual([]);
  });

  it("flags two edges landing on one input pin", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({
      id: "scalar",
      type: "const.float",
      position: { x: 0, y: 0 },
      properties: {},
    });
    doc.edges.push(
      {
        id: "first",
        sourceNodeId: "scalar",
        sourcePinId: "out",
        targetNodeId: "output",
        targetPinId: "metallic",
      },
      {
        id: "second",
        sourceNodeId: "scalar",
        sourcePinId: "out",
        targetNodeId: "output",
        targetPinId: "metallic",
      },
    );
    expect(codes(doc)).toContain("material.duplicateConnection");
  });

  it("flags a cycle in the data graph", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(
      { id: "a1", type: "math.add", position: { x: 0, y: 0 }, properties: {} },
      { id: "a2", type: "math.add", position: { x: 0, y: 0 }, properties: {} },
    );
    doc.edges.push(
      {
        id: "loop-1",
        sourceNodeId: "a1",
        sourcePinId: "out",
        targetNodeId: "a2",
        targetPinId: "a",
      },
      {
        id: "loop-2",
        sourceNodeId: "a2",
        sourcePinId: "out",
        targetNodeId: "a1",
        targetPinId: "a",
      },
    );
    expect(codes(doc)).toContain("material.cycle");
  });

  it("flags a post-process node used inside a surface material", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({
      id: "scene",
      type: "input.sceneColor",
      position: { x: 0, y: 0 },
      properties: {},
    });
    expect(codes(doc)).toContain("material.domainMismatch");
  });

  it("flags Scene Normal inside a surface material", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({
      id: "n",
      type: "input.sceneNormal",
      position: { x: 0, y: 0 },
      properties: {},
    });
    expect(codes(doc)).toContain("material.domainMismatch");
  });

  it("flags Particle Color inside a surface material", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({
      id: "pc",
      type: "input.particleColor",
      position: { x: 0, y: 0 },
      properties: {},
    });
    expect(codes(doc)).toContain("material.domainMismatch");
  });

  it("names the particle domain when a surface node is illegal there", () => {
    const doc = createDefaultMaterialDocument("Sparks", "particle");
    doc.nodes.push({
      id: "wp",
      type: "input.worldPosition",
      position: { x: 0, y: 0 },
      properties: {},
    });
    const diagnostic = validateMaterialDocument(doc).find(
      (row) => row.code === "material.domainMismatch",
    );
    expect(diagnostic?.message).toMatch(/particle/i);
  });

  it("flags Scene Normal when the device has no sceneNormal capability", () => {
    const doc = createDefaultMaterialDocument("Fog", "postProcess");
    doc.nodes.push({
      id: "n",
      type: "input.sceneNormal",
      position: { x: 0, y: 0 },
      properties: {},
    });
    expect(codes(doc, { capabilities: { sceneNormal: false } })).toContain(
      "material.capability",
    );
  });

  it("flags more than one terminal", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({
      id: "second-output",
      type: "output.surface",
      position: { x: 0, y: 0 },
      properties: {},
    });
    expect(codes(doc)).toContain("material.multipleOutputs");
  });

  it("flags a texture sample with no texture wired in", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({
      id: "sample",
      type: "texture.sample",
      position: { x: 0, y: 0 },
      properties: {},
    });
    expect(codes(doc)).toContain("material.missingInput");
  });

  it("accepts a texture sample that stores an inline Texture asset", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({
      id: "sample",
      type: "texture.sample",
      position: { x: 0, y: 0 },
      properties: { textureGuid: "tex-1" },
    });
    expect(codes(doc, { textureExists: () => true })).not.toContain(
      "material.missingInput",
    );
  });

  it("flags a texture parameter whose asset is gone", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({
      id: "tex",
      type: "param.texture",
      position: { x: 0, y: 0 },
      properties: { textureGuid: "gone" },
    });
    expect(
      codes(doc, { textureExists: () => false }),
    ).toContain("material.missingTexture");
  });

  it("flags a derivative node when the device has no derivatives", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({
      id: "dx",
      type: "derivative.ddx",
      position: { x: 0, y: 0 },
      properties: {},
    });
    expect(codes(doc, { capabilities: { derivatives: false } })).toContain(
      "material.capability",
    );
  });

  it("flags an empty Custom GLSL body", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({
      id: "glsl",
      type: "custom.glsl",
      position: { x: 0, y: 0 },
      properties: { ...newCustomGlslProperties(), body: "   " },
    });
    expect(codes(doc)).toContain("material.customGlsl");
  });

  it("flags a Custom GLSL node without a typed pin interface", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({
      id: "glsl",
      type: "custom.glsl",
      position: { x: 0, y: 0 },
      properties: { body: "return A;" },
    });
    expect(codes(doc)).toContain("material.customGlsl");
  });

  it("warns that a post-process material costs fill rate on the iPad baseline", () => {
    const doc = createDefaultMaterialDocument("Blur", "postProcess");
    const warning = validateMaterialDocument(doc, {
      warnPostProcessCost: true,
    }).find((row) => row.code === "material.postProcessCost");
    expect(warning?.severity).toBe("warning");
  });

  it("flags a call to a function that is not in the project", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({
      id: "call",
      type: "function.call",
      position: { x: 0, y: 0 },
      properties: { functionGuid: "missing-fn" },
    });
    expect(codes(doc, { functions: {} })).toContain("material.function.missing");
  });

  it("flags a call node with no function selected", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({
      id: "call",
      type: "function.call",
      position: { x: 0, y: 0 },
      properties: {},
    });
    expect(codes(doc)).toContain("material.function.missing");
  });

  it("accepts a call to a function that exists", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({
      id: "call",
      type: "function.call",
      position: { x: 0, y: 0 },
      properties: { functionGuid: "fn-1" },
    });
    expect(
      codes(doc, { functions: { "fn-1": createDefaultMaterialFunctionDocument() } }),
    ).not.toContain("material.function.missing");
  });

  it("lets a particle material call a domain-neutral math function", () => {
    const fn = createDefaultMaterialFunctionDocument("Tint");
    fn.inputs = [{ id: "in_value", name: "Value", type: "vec4" }];
    fn.outputs = [{ id: "out_value", name: "Result", type: "vec4" }];
    const doc = createDefaultMaterialDocument("Sparks", "particle");
    doc.nodes.push({
      id: "call",
      type: "function.call",
      position: { x: 0, y: 0 },
      properties: { functionGuid: "fn-1" },
    });
    doc.edges = doc.edges.filter((edge) => edge.targetPinId !== "color");
    doc.edges.push({
      id: "e-fn-color",
      sourceNodeId: "call",
      sourcePinId: "out_value",
      targetNodeId: "output",
      targetPinId: "color",
    });
    expect(
      validateMaterialDocument(doc, {
        functions: { "fn-1": fn },
      }),
    ).toEqual([]);
  });

  it("does not let a numeric default kept from an earlier type satisfy a function's Texture input", () => {
    const fn = createDefaultMaterialFunctionDocument("Sample");
    // The input was a Float with a default, then retyped to Texture.
    fn.inputs = [{ id: "in_map", name: "Map", type: "texture", defaultValue: [0.5] }];
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({ id: "call", type: "function.call", position: { x: 0, y: 0 }, properties: { functionGuid: "fn-1" } });

    expect(validateMaterialDocument(doc, { functions: { "fn-1": fn } }))
      .toContainEqual(expect.objectContaining({ code: "material.missingInput", nodeId: "call", pinId: "in_map" }));
  });

  it("flags Function Input and Function Output in a Material, and a Material output node in a function", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({ id: "stray", type: "function.input", position: { x: 0, y: 0 }, properties: {} });
    expect(validateMaterialDocument(doc)).toContainEqual(expect.objectContaining({ code: "material.function.misplaced", nodeId: "stray" }));

    const fn = createDefaultMaterialFunctionDocument("Tint");
    fn.nodes.push({ id: "surface", type: "output.surface", position: { x: 0, y: 0 }, properties: {} });
    expect(validateMaterialFunctionDocument(fn)).toContainEqual(expect.objectContaining({ code: "material.function.misplaced", nodeId: "surface" }));
    // Each graph's own plumbing is not flagged.
    expect(validateMaterialDocument(createDefaultMaterialDocument()).map((row) => row.code)).not.toContain("material.function.misplaced");
    expect(validateMaterialFunctionDocument(createDefaultMaterialFunctionDocument("Tint")).map((row) => row.code)).not.toContain("material.function.misplaced");
  });

  it("flags recursive function dependencies", () => {
    const outer = createDefaultMaterialFunctionDocument("Outer");
    outer.nodes.push({
      id: "call-inner",
      type: "function.call",
      position: { x: 0, y: 0 },
      properties: { functionGuid: "fn-outer" },
    });
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({
      id: "call",
      type: "function.call",
      position: { x: 0, y: 0 },
      properties: { functionGuid: "fn-outer" },
    });
    outer.edges = [{ id: "recursive-result", sourceNodeId: "call-inner", sourcePinId: "out_value", targetNodeId: "outputs", targetPinId: "out_value" }];
    doc.edges.push({ id: "recursive-wpo", sourceNodeId: "call", sourcePinId: "out_value", targetNodeId: "output", targetPinId: "worldPositionOffset" });
    expect(codes(doc, { functions: { "fn-outer": outer } })).toContain(
      "material.function.recursive",
    );
  });

  it("reports invalid nested function bodies at their call path instead of lowering a fallback", () => {
    const inner = createDefaultMaterialFunctionDocument("Inner");
    inner.nodes.push({ id: "invalid", type: "unknown.node", position: { x: 0, y: 0 }, properties: {} });
    inner.edges = [{ id: "invalid-result", sourceNodeId: "invalid", sourcePinId: "out", targetNodeId: "outputs", targetPinId: "out_value" }];
    const outer = createDefaultMaterialFunctionDocument("Outer");
    outer.nodes.push({ id: "nested", type: "function.call", position: { x: 0, y: 0 }, properties: { functionGuid: "inner" } });
    outer.edges = [{ id: "nested-result", sourceNodeId: "nested", sourcePinId: "out_value", targetNodeId: "outputs", targetPinId: "out_value" }];
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({ id: "call", type: "function.call", position: { x: 0, y: 0 }, properties: { functionGuid: "outer" } });
    expect(validateMaterialDocument(doc, { functions: { inner, outer } })).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "material.unknownNode", nodeId: "call/nested/invalid" }),
    ]));
  });

  it("validates shared function bodies within a linear work budget, including disconnected calls", () => {
    const functions: Record<string, MaterialFunctionDocument> = {};
    const depth = 12;
    const call = (id: string, functionGuid: string) => ({
      id, type: "function.call", position: { x: 0, y: 0 }, properties: { functionGuid },
    });
    for (let i = 0; i < depth; i += 1) {
      const fn = createDefaultMaterialFunctionDocument(`Function ${i}`);
      if (i + 1 < depth) fn.nodes.push(call("first", `f${i + 1}`), call("second", `f${i + 1}`));
      else fn.nodes.push({ id: "invalid", type: "unknown.node", position: { x: 0, y: 0 }, properties: {} });
      functions[`f${i}`] = fn;
    }
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(call("root", "f0"));
    let lookups = 0;
    const measured = new Proxy(functions, { get(target, key: string) { lookups += 1; return target[key]; } });
    const diagnostics = validateMaterialDocument(doc, { functions: measured });
    expect(diagnostics.filter(row => row.code === "material.unknownNode")).toEqual([
      expect.objectContaining({ nodeId: `root/${"first/".repeat(depth - 1)}invalid` }),
    ]);
    expect(lookups).toBeLessThan(depth * 50);

    // A back edge must still be diagnosed after shared siblings were visited.
    functions.f11!.nodes.push(call("back", "f0"), call("missing", "absent"));
    const dependencies = collectFunctionDependencies(doc, functions);
    expect(dependencies.guids).toHaveLength(depth);
    expect(dependencies.recursion).toEqual([...Array.from({ length: depth }, (_, i) => `f${i}`), "f0"]);
    expect(dependencies.missing).toEqual(["absent"]);
  });

  it("checks function nodes against the calling material domain", () => {
    const fn = createDefaultMaterialFunctionDocument();
    fn.nodes.push({ id: "world", type: "input.worldPosition", position: { x: 0, y: 0 }, properties: {} });
    fn.edges = [{ id: "world-result", sourceNodeId: "world", sourcePinId: "position", targetNodeId: "outputs", targetPinId: "out_value" }];
    const doc = createDefaultMaterialDocument("Post", "postProcess");
    doc.nodes.push({ id: "call", type: "function.call", position: { x: 0, y: 0 }, properties: { functionGuid: "fn" } });
    expect(validateMaterialDocument(doc, { functions: { fn } })).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "material.domainMismatch", nodeId: "call/world" }),
    ]));
  });

  it("anchors every diagnostic to a node or edge id", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({
      id: "bogus",
      type: "math.doesNotExist",
      position: { x: 0, y: 0 },
      properties: {},
    });
    const diagnostic = validateMaterialDocument(doc).find(
      (row) => row.code === "material.unknownNode",
    );
    expect(diagnostic?.nodeId).toBe("bogus");
  });

  it("flags a fragment-only node wired into World Position Offset", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(
      { id: "uv", type: "input.uv", position: { x: 0, y: 0 }, properties: {} },
      {
        id: "ddx",
        type: "derivative.ddx",
        position: { x: 0, y: 0 },
        properties: {},
      },
      {
        id: "combine",
        type: "vector.combine",
        position: { x: 0, y: 0 },
        properties: {},
      },
    );
    doc.edges.push(
      {
        id: "e-uv-ddx",
        sourceNodeId: "uv",
        sourcePinId: "uv",
        targetNodeId: "ddx",
        targetPinId: "value",
      },
      {
        id: "e-ddx-combine",
        sourceNodeId: "ddx",
        sourcePinId: "out",
        targetNodeId: "combine",
        targetPinId: "x",
      },
      {
        id: "e-combine-wpo",
        sourceNodeId: "combine",
        sourcePinId: "xyz",
        targetNodeId: "output",
        targetPinId: "worldPositionOffset",
      },
    );
    const diagnostic = validateMaterialDocument(doc).find(
      (row) => row.code === "material.stageMismatch",
    );
    expect(diagnostic?.nodeId).toBe("ddx");
    expect(diagnostic?.message).toMatch(/World Position Offset/i);
  });

  it("flags Screen Size wired into World Position Offset, where its block cannot run", () => {
    const doc = createDefaultMaterialDocument();
    const edge = (sourceNodeId: string, sourcePinId: string, targetNodeId: string, targetPinId: string) =>
      ({ id: `${sourceNodeId}-${targetNodeId}`, sourceNodeId, sourcePinId, targetNodeId, targetPinId });
    doc.nodes.push(
      { id: "size", type: "input.screenSize", position: { x: 0, y: 0 }, properties: {} },
      { id: "split", type: "vector.split", position: { x: 0, y: 0 }, properties: {} },
      { id: "combine", type: "vector.combine", position: { x: 0, y: 0 }, properties: {} },
    );
    doc.edges.push(
      edge("size", "size", "split", "value"),
      edge("split", "x", "combine", "x"),
      edge("combine", "xyz", "output", "worldPositionOffset"),
    );
    // Unreported, this reaches Babylon and fails the whole build with no node to point at.
    expect(validateMaterialDocument(doc).find((row) => row.code === "material.stageMismatch")?.nodeId).toBe("size");
  });

  it("allows Time and Sine to drive World Position Offset", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(
      { id: "time", type: "input.time", position: { x: 0, y: 0 }, properties: {} },
      { id: "sin", type: "math.sin", position: { x: 0, y: 0 }, properties: {} },
      {
        id: "combine",
        type: "vector.combine",
        position: { x: 0, y: 0 },
        properties: {},
      },
    );
    doc.edges.push(
      {
        id: "e-time-sin",
        sourceNodeId: "time",
        sourcePinId: "time",
        targetNodeId: "sin",
        targetPinId: "value",
      },
      {
        id: "e-sin-combine",
        sourceNodeId: "sin",
        sourcePinId: "out",
        targetNodeId: "combine",
        targetPinId: "y",
      },
      {
        id: "e-combine-wpo",
        sourceNodeId: "combine",
        sourcePinId: "xyz",
        targetNodeId: "output",
        targetPinId: "worldPositionOffset",
      },
    );
    expect(codes(doc)).not.toContain("material.stageMismatch");
  });

  it("does not flag a fragment-only node that only feeds Base Color", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(
      { id: "uv", type: "input.uv", position: { x: 0, y: 0 }, properties: {} },
      {
        id: "ddx",
        type: "derivative.ddx",
        position: { x: 0, y: 0 },
        properties: {},
      },
    );
    doc.edges = doc.edges.filter((edge) => edge.id !== "e-color-output");
    doc.edges.push(
      {
        id: "e-uv-ddx",
        sourceNodeId: "uv",
        sourcePinId: "uv",
        targetNodeId: "ddx",
        targetPinId: "value",
      },
      {
        id: "e-ddx-color",
        sourceNodeId: "ddx",
        sourcePinId: "out",
        targetNodeId: "output",
        targetPinId: "baseColor",
      },
    );
    expect(codes(doc)).not.toContain("material.stageMismatch");
  });

  it("flags a fragment-only node inside a function that feeds World Position Offset", () => {
    const fn = createDefaultMaterialFunctionDocument("Wave");
    fn.nodes.push({
      id: "ddx",
      type: "derivative.ddx",
      position: { x: 0, y: 0 },
      properties: {},
    });
    fn.edges = [
      {
        id: "e-in-ddx",
        sourceNodeId: "inputs",
        sourcePinId: "in_value",
        targetNodeId: "ddx",
        targetPinId: "value",
      },
      {
        id: "e-ddx-out",
        sourceNodeId: "ddx",
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
      properties: { functionGuid: "fn-wave" },
    });
    doc.edges.push({
      id: "e-call-wpo",
      sourceNodeId: "call",
      sourcePinId: "out_value",
      targetNodeId: "output",
      targetPinId: "worldPositionOffset",
    });
    const diagnostic = validateMaterialDocument(doc, {
      functions: { "fn-wave": fn },
    }).find((row) => row.code === "material.stageMismatch");
    expect(diagnostic?.nodeId).toBe("call/ddx");
  });
});

describe("Named Reroute validation", () => {
  const wire = (id: string, sourceNodeId: string, sourcePinId: string, targetNodeId: string, targetPinId: string) =>
    ({ id, sourceNodeId, sourcePinId, targetNodeId, targetPinId });
  const declaration = (id: string, name: string) =>
    ({ id, type: "reroute.declaration", position: { x: 0, y: 0 }, properties: { name, color: [1, 0, 0] } });
  const usage = (id: string, declarationId: string) =>
    ({ id, type: "reroute.usage", position: { x: 0, y: 0 }, properties: { declarationId } });
  const rows = (doc: MaterialDocument | MaterialFunctionDocument, context = {}) =>
    ("domain" in doc ? validateMaterialDocument(doc, context) : validateMaterialFunctionDocument(doc, context))
      .map((row) => ({ code: row.code, nodeId: row.nodeId, message: row.message }));

  it("accepts a wired declaration with several usages", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(declaration("r", "Color"), usage("u", "r"), usage("v", "r"));
    doc.edges = [wire("e-color-r", "baseColor", "out", "r", "in"), wire("e-u", "u", "out", "output", "baseColor"), wire("e-v", "v", "out", "output", "emissive")];
    expect(validateMaterialDocument(doc)).toEqual([]);
  });

  it("requires a nonblank name, unique among the graph's declarations", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(declaration("blank", "  "), declaration("a", "Shared"), declaration("b", " Shared "), declaration("c", "Other"));
    expect(rows(doc)).toEqual([
      { code: "material.reroute.missingName", nodeId: "blank", message: "Named Reroute needs a unique name" },
      { code: "material.reroute.duplicateName", nodeId: "a", message: 'Named Reroute name "Shared" is already used; choose a unique name' },
      { code: "material.reroute.duplicateName", nodeId: "b", message: 'Named Reroute name "Shared" is already used; choose a unique name' },
    ]);
  });

  it("reports a usage whose declaration is not in its graph", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(usage("u", "gone"));
    doc.edges.push(wire("e-u", "u", "out", "output", "metallic"));
    expect(rows(doc)).toEqual([{ code: "material.reroute.missingDeclaration", nodeId: "u", message: "Named Reroute is missing" }]);
  });

  it("reports a declaration reading its own usage, directly or through other nodes, once and not as a cycle", () => {
    const direct = createDefaultMaterialDocument();
    direct.nodes.push(declaration("r", "Loop"), usage("u", "r"));
    direct.edges.push(wire("e-u-r", "u", "out", "r", "in"));
    expect(rows(direct)).toEqual([{ code: "material.reroute.selfUse", nodeId: "r", message: 'Named Reroute "Loop" uses itself' }]);

    const indirect = createDefaultMaterialDocument();
    indirect.nodes.push(declaration("r", "Loop"), usage("u", "r"), usage("w", "r"),
      { id: "add", type: "math.add", position: { x: 0, y: 0 }, properties: {} },
      { id: "sin", type: "math.sin", position: { x: 0, y: 0 }, properties: {} });
    indirect.edges.push(
      wire("e-color-add", "baseColor", "out", "add", "a"), wire("e-u-sin", "u", "out", "sin", "value"),
      wire("e-sin-add", "sin", "out", "add", "b"), wire("e-add-r", "add", "out", "r", "in"),
      wire("e-w-emissive", "w", "out", "output", "emissive"),
    );
    expect(rows(indirect)).toEqual([{ code: "material.reroute.selfUse", nodeId: "r", message: 'Named Reroute "Loop" uses itself' }]);
  });

  it("reports every declaration on a loop between Named Reroutes", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(declaration("x", "X"), usage("ux", "x"), declaration("y", "Y"), usage("uy", "y"),
      declaration("z", "Z"), usage("uz", "z"));
    // X reads Y and Y reads X; Z only reads the loop.
    doc.edges.push(wire("e-uy-x", "uy", "out", "x", "in"), wire("e-ux-y", "ux", "out", "y", "in"), wire("e-ux-z", "ux", "out", "z", "in"),
      wire("e-uz", "uz", "out", "output", "metallic"));
    expect(rows(doc).map((row) => [row.code, row.nodeId])).toEqual([
      ["material.reroute.selfUse", "x"],
      ["material.reroute.selfUse", "y"],
    ]);
  });

  it("reports Named Reroute errors inside a called Material Function under the call's path", () => {
    const fn = createDefaultMaterialFunctionDocument("Loop");
    fn.nodes.push(declaration("r", "Inner"), usage("u", "r"), usage("gone", "elsewhere"));
    fn.edges.push(wire("e-u-r", "u", "out", "r", "in"));
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({ id: "call", type: "function.call", position: { x: 0, y: 0 }, properties: { functionGuid: "fn" } });
    doc.edges = [wire("e-color-call", "baseColor", "out", "call", "in_value"), wire("e-call-out", "call", "out_value", "output", "baseColor")];
    expect(rows(doc, { functions: { fn } }).map((row) => [row.code, row.nodeId])).toEqual([
      ["material.reroute.selfUse", "call/r"],
      ["material.reroute.missingDeclaration", "call/gone"],
    ]);
    expect(rows(fn).map((row) => [row.code, row.nodeId])).toEqual([
      ["material.reroute.selfUse", "r"],
      ["material.reroute.missingDeclaration", "gone"],
    ]);
  });

  it("reports blank and duplicate Named Reroute names inside a called Material Function on the calling Material", () => {
    const fn = createDefaultMaterialFunctionDocument("Names");
    fn.nodes.push(declaration("blank", " "), declaration("a", "Same"), declaration("b", "Same"));
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({ id: "call", type: "function.call", position: { x: 0, y: 0 }, properties: { functionGuid: "fn" } });
    doc.edges = [wire("e-color-call", "baseColor", "out", "call", "in_value"), wire("e-call-out", "call", "out_value", "output", "baseColor")];
    expect(rows(doc, { functions: { fn } }).map((row) => [row.code, row.nodeId])).toEqual([
      ["material.reroute.missingName", "call/blank"],
      ["material.reroute.duplicateName", "call/a"],
      ["material.reroute.duplicateName", "call/b"],
    ]);
  });

  it("scopes declarations to their graph: a function's usage cannot read the Material's declaration", () => {
    const fn = createDefaultMaterialFunctionDocument("Reader");
    fn.nodes.push(usage("u", "r"));
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(declaration("r", "Outer"), { id: "call", type: "function.call", position: { x: 0, y: 0 }, properties: { functionGuid: "fn" } });
    doc.edges = [wire("e-color-r", "baseColor", "out", "r", "in"), wire("e-color-call", "baseColor", "out", "call", "in_value"), wire("e-call-out", "call", "out_value", "output", "baseColor")];
    expect(rows(doc, { functions: { fn } }).map((row) => [row.code, row.nodeId])).toEqual([["material.reroute.missingDeclaration", "call/u"]]);
  });

  it("checks types through a Named Reroute: a Texture usage cannot feed a numeric input", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({ id: "albedo", type: "param.texture", position: { x: 0, y: 0 }, properties: { name: "Albedo", textureGuid: "tex" } },
      declaration("r", "Albedo Texture"), usage("u", "r"));
    doc.edges.push(wire("e-albedo-r", "albedo", "out", "r", "in"), wire("e-u-metallic", "u", "out", "output", "metallic"));
    expect(codes(doc)).toEqual(["material.typeMismatch"]);
  });

  it("follows a Named Reroute from World Position Offset to a fragment-only node", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({ id: "uv", type: "input.uv", position: { x: 0, y: 0 }, properties: {} },
      { id: "ddx", type: "derivative.ddx", position: { x: 0, y: 0 }, properties: {} },
      declaration("r", "Slope"), usage("u", "r"));
    doc.edges.push(wire("e-uv-ddx", "uv", "uv", "ddx", "value"), wire("e-ddx-r", "ddx", "out", "r", "in"),
      wire("e-u-wpo", "u", "out", "output", "worldPositionOffset"));
    expect(validateMaterialDocument(doc).find((row) => row.code === "material.stageMismatch")?.nodeId).toBe("ddx");
  });
});
