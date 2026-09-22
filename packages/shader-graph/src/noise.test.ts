import { describe, expect, it } from "vitest";
import { createDefaultMaterialDocument, createDefaultMaterialFunctionDocument } from "./document";
import { lowerMaterialDocument } from "./lower";
import { hydrateMaterialGraphForEditor, materialGraphToSerialized, serializedToMaterialGraph } from "./serialize-material";
import { validateMaterialDocument } from "./validate";

describe("material noise graphs", () => {
  it("retains noise controls and secondary output connections through editor serialization", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({ id: "noise", type: "noise.worley", position: { x: 50, y: 80 }, properties: { "default:coordinates": [1, 2, 3], "default:jitter": [0.4] } });
    doc.edges.push({ id: "noise-output", sourceNodeId: "noise", sourcePinId: "f2", targetNodeId: "output", targetPinId: "roughness" });
    const restored = serializedToMaterialGraph(hydrateMaterialGraphForEditor(materialGraphToSerialized(doc)), doc);
    const lowered = lowerMaterialDocument(restored);
    expect(lowered.ok).toBe(true);
    if (!lowered.ok) return;
    expect(lowered.plan.outputs.roughness).toEqual({ kind: "operation", operationId: "noise", pinId: "f2" });
    expect(lowered.plan.operations.find((operation) => operation.id === "noise")?.inputs).toEqual({
      coordinates: { kind: "constant", type: "vec3", value: [1, 2, 3] },
      jitter: { kind: "constant", type: "float", value: [0.4] },
    });
    expect(lowered.plan.cost.textureSamples).toBe(0);
    expect(lowered.plan.cost.weight).toBeGreaterThan(1);
  });

  it("provides Perlin coordinate defaults and Voronoi controls while leaving UV available for the compiler fallback", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(
      { id: "perlin", type: "noise.perlin", position: { x: 0, y: 0 }, properties: {} },
      { id: "voronoi", type: "noise.voronoi", position: { x: 0, y: 0 }, properties: {} },
    );
    doc.edges.push(
      { id: "perlin-out", sourceNodeId: "perlin", sourcePinId: "out", targetNodeId: "output", targetPinId: "roughness" },
      { id: "voronoi-out", sourceNodeId: "voronoi", sourcePinId: "cells", targetNodeId: "output", targetPinId: "metallic" },
    );
    const lowered = lowerMaterialDocument(doc);
    expect(lowered.ok).toBe(true);
    if (!lowered.ok) return;
    expect(lowered.plan.operations.find((operation) => operation.id === "perlin")?.inputs.coordinates).toEqual({ kind: "constant", type: "vec3", value: [0, 0, 0] });
    expect(lowered.plan.operations.find((operation) => operation.id === "voronoi")?.inputs).toEqual({
      offset: { kind: "constant", type: "float", value: [0] },
      density: { kind: "constant", type: "float", value: [5] },
    });
  });

  it("rejects a UV vector wired directly into a three-dimensional noise coordinate", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(
      { id: "uv", type: "input.uv", position: { x: 0, y: 0 }, properties: {} },
      { id: "noise", type: "noise.perlin", position: { x: 0, y: 0 }, properties: {} },
    );
    doc.edges.push({ id: "bad-width", sourceNodeId: "uv", sourcePinId: "uv", targetNodeId: "noise", targetPinId: "coordinates" });
    expect(validateMaterialDocument(doc)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "material.typeMismatch", edgeId: "bad-width" }),
    ]));
  });

  it("inlines noise functions with their typed coordinate input and output", () => {
    const fn = createDefaultMaterialFunctionDocument("Noise");
    fn.inputs = [{ id: "coordinates", name: "Coordinates", type: "vec3", defaultValue: [0, 0, 0] }];
    fn.outputs = [{ id: "noise", name: "Noise", type: "float" }];
    fn.nodes = [
      { id: "inputs", type: "function.input", position: { x: 0, y: 0 }, properties: {} },
      { id: "noise", type: "noise.perlin", position: { x: 0, y: 0 }, properties: {} },
      { id: "outputs", type: "function.output", position: { x: 0, y: 0 }, properties: {} },
    ];
    fn.edges = [
      { id: "coordinates", sourceNodeId: "inputs", sourcePinId: "coordinates", targetNodeId: "noise", targetPinId: "coordinates" },
      { id: "noise", sourceNodeId: "noise", sourcePinId: "out", targetNodeId: "outputs", targetPinId: "noise" },
    ];
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({ id: "call", type: "function.call", position: { x: 0, y: 0 }, properties: { functionGuid: "noise-function", "default:coordinates": [2, 3, 4] } });
    doc.edges.push({ id: "function-out", sourceNodeId: "call", sourcePinId: "noise", targetNodeId: "output", targetPinId: "roughness" });
    const lowered = lowerMaterialDocument(doc, { functions: { "noise-function": fn } });
    expect(lowered.ok).toBe(true);
    if (!lowered.ok) return;
    expect(lowered.plan.operations.find((operation) => operation.nodeType === "noise.perlin")).toMatchObject({
      id: "call/noise",
      inputs: { coordinates: { kind: "constant", type: "vec3", value: [2, 3, 4] } },
    });
    expect(lowered.plan.outputs.roughness).toEqual({ kind: "operation", operationId: "call/noise", pinId: "out" });
  });
});
