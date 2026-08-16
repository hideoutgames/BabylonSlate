import { describe, expect, it } from "vitest";
import {
  createDefaultMaterialDocument,
  createDefaultMaterialFunctionDocument,
  type MaterialDocument,
} from "./document";
import { validateMaterialDocument } from "./validate";

function codes(doc: MaterialDocument, context = {}): string[] {
  return validateMaterialDocument(doc, context).map((row) => row.code);
}

describe("material validation", () => {
  it("accepts the default surface material", () => {
    expect(validateMaterialDocument(createDefaultMaterialDocument())).toEqual(
      [],
    );
  });

  it("accepts the default post-process material", () => {
    const doc = createDefaultMaterialDocument("Blur", "postProcess");
    expect(validateMaterialDocument(doc)).toEqual([]);
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

  it("flags a vector width mismatch instead of silently truncating", () => {
    const doc = createDefaultMaterialDocument();
    doc.edges.push({
      id: "too-wide",
      sourceNodeId: "baseColor",
      sourcePinId: "out",
      targetNodeId: "output",
      targetPinId: "baseColor",
    });
    const diagnostics = validateMaterialDocument(doc);
    const mismatch = diagnostics.find(
      (row) => row.code === "material.typeMismatch",
    );
    expect(mismatch).toBeDefined();
    expect(mismatch?.message).toContain("Vector 4");
    expect(mismatch?.message).toContain("Vector 3");
  });

  it("allows a float to splat into a vector pin", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({
      id: "scalar",
      type: "const.float",
      position: { x: 0, y: 0 },
      properties: { value: [0.5] },
    });
    doc.edges.push({
      id: "splat",
      sourceNodeId: "scalar",
      sourcePinId: "out",
      targetNodeId: "output",
      targetPinId: "emissive",
    });
    expect(codes(doc)).not.toContain("material.typeMismatch");
  });

  it("flags a generic node whose inputs disagree on width", () => {
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
    expect(codes(doc)).toContain("material.genericConflict");
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
    expect(codes(doc, { functions: { "fn-outer": outer } })).toContain(
      "material.function.recursive",
    );
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
});
