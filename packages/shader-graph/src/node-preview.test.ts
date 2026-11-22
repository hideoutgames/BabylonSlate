import { describe, expect, it } from "vitest";
import { createDefaultMaterialDocument, type MaterialDocument } from "./document";
import { lowerMaterialDocument } from "./lower";
import { materialNodePreviewDocument, materialNodePreviewOutputs } from "./node-preview";

const at = { x: 0, y: 0 };

/** The default surface (Color into Base Color) plus a noise into Roughness, an unwired UV and a Texture Parameter. */
function surface(): MaterialDocument {
  const doc = createDefaultMaterialDocument();
  doc.nodes = doc.nodes.map((node) => node.id === "output" ? { ...node, properties: { "default:emissive": [1, 0, 0] } } : node);
  doc.nodes.push(
    { id: "noise", type: "noise.perlin", position: at, properties: {} },
    { id: "uv", type: "input.uv", position: at, properties: {} },
    { id: "sample", type: "texture.sample", position: at, properties: { textureGuid: "rock-texture" } },
    { id: "albedo", type: "param.texture", position: at, properties: { name: "Albedo" } },
  );
  doc.edges.push({ id: "e-noise-roughness", sourceNodeId: "noise", sourcePinId: "out", targetNodeId: "output", targetPinId: "roughness" });
  return doc;
}

/** Each wire into a node as `source.pin -> pin`, sorted. */
function wiresInto(doc: MaterialDocument, nodeId: string): string[] {
  return doc.edges
    .filter((edge) => edge.targetNodeId === nodeId)
    .map((edge) => `${edge.sourceNodeId}.${edge.sourcePinId} -> ${edge.targetPinId}`)
    .sort();
}

describe("materialNodePreviewOutputs", () => {
  it("lists every numeric output in pin order and never a Texture or an output node", () => {
    const doc = surface();
    expect(materialNodePreviewOutputs(doc, "noise")).toEqual([{ pinId: "out", name: "Value" }]);
    expect(materialNodePreviewOutputs(doc, "sample").map((output) => output.pinId)).toEqual(["rgba", "rgb", "r", "g", "b", "a"]);
    expect(materialNodePreviewOutputs(doc, "albedo")).toEqual([]);
    expect(materialNodePreviewOutputs(doc, "output")).toEqual([]);
    expect(materialNodePreviewOutputs(doc, "missing")).toEqual([]);
  });
});

describe("materialNodePreviewDocument", () => {
  it("wires a Float output alone into Base Color through every channel, unlit and opaque", () => {
    const doc = surface();
    const before = structuredClone(doc);
    const preview = materialNodePreviewDocument(doc, { nodeId: "noise", pinId: "out" })!;

    expect(preview.shadingModel).toBe("unlit");
    expect(preview.blendMode).toBe("opaque");
    // The Material's own wires and pin defaults on the output node no longer reach the preview.
    expect(wiresInto(preview, "output")).toEqual(["__previewCombine.xyz -> baseColor"]);
    expect(preview.nodes.find((node) => node.id === "output")!.properties).toEqual({});
    expect(wiresInto(preview, "__previewSplit")).toEqual(["noise.out -> value"]);
    expect(wiresInto(preview, "__previewCombine")).toEqual([
      "__previewSplit.x -> x",
      "__previewSplit.y -> y",
      "__previewSplit.z -> z",
    ]);
    expect(lowerMaterialDocument(preview).ok).toBe(true);
    expect(doc).toEqual(before);
  });

  it("leaves blue at 0 for a Vector2 output", () => {
    const preview = materialNodePreviewDocument(surface(), { nodeId: "uv", pinId: "uv" })!;
    expect(wiresInto(preview, "__previewCombine")).toEqual(["__previewSplit.x -> x", "__previewSplit.y -> y"]);
    expect(lowerMaterialDocument(preview).ok).toBe(true);
  });

  it("wires a Post Process Material's preview into the output's Color", () => {
    const doc = createDefaultMaterialDocument("Grade", "postProcess");
    const preview = materialNodePreviewDocument(doc, { nodeId: "screenUv", pinId: materialNodePreviewOutputs(doc, "screenUv")[0]!.pinId })!;
    expect(wiresInto(preview, "output")).toEqual(["__previewCombine.xyz -> color"]);
    expect(lowerMaterialDocument(preview).ok).toBe(true);
  });

  it("wires a User Interface Material's preview into the output's Color and leaves Opacity at 1", () => {
    const doc = createDefaultMaterialDocument("Panel", "ui");
    doc.nodes = doc.nodes.map((node) => node.id === "output" ? { ...node, properties: { "default:opacity": [0.25] } } : node);
    doc.nodes.push({ id: "box", type: "ui.roundedRectangle", position: at, properties: {} });
    doc.edges.push({ id: "e-box-opacity", sourceNodeId: "box", sourcePinId: "fill", targetNodeId: "output", targetPinId: "opacity" });
    const preview = materialNodePreviewDocument(doc, { nodeId: "box", pinId: "distance" })!;
    expect(wiresInto(preview, "output")).toEqual(["__previewCombine.xyz -> color"]);
    const lowered = lowerMaterialDocument(preview);
    expect(lowered.ok).toBe(true);
    if (!lowered.ok) return;
    expect(lowered.plan.outputs.color).toEqual({ kind: "operation", operationId: "__previewCombine", pinId: "xyz" });
    // (A Material Output literal is also marked hoisted, for programs that read the Material record.)
    expect(lowered.plan.outputs.opacity).toMatchObject({ kind: "constant", type: "float", value: [1] });
  });

  it("is null for a missing node, an unknown output and a Texture output", () => {
    const doc = surface();
    expect(materialNodePreviewDocument(doc, { nodeId: "missing", pinId: "out" })).toBeNull();
    expect(materialNodePreviewDocument(doc, { nodeId: "noise", pinId: "nope" })).toBeNull();
    expect(materialNodePreviewDocument(doc, { nodeId: "albedo", pinId: "out" })).toBeNull();
  });

  it("names its helper nodes apart from the Material's own", () => {
    const doc = surface();
    doc.nodes.push({ id: "__previewSplit", type: "noise.perlin", position: at, properties: {} });
    const preview = materialNodePreviewDocument(doc, { nodeId: "noise", pinId: "out" })!;
    expect(wiresInto(preview, "__previewSplit_1")).toEqual(["noise.out -> value"]);
    expect(preview.nodes.filter((node) => node.id === "__previewSplit")).toHaveLength(1);
  });
});
