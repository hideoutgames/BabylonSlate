import { describe, expect, it } from "vitest";
import { createDefaultMaterialDocument, type MaterialDocument } from "./document";
import { lowerMaterialDocument } from "./lower";
import { materialSamplerBudgetDiagnostics as planDiagnostics } from "./sampler-budget";

function materialSamplerBudgetDiagnostics(document: MaterialDocument, { samplerBudget }: { samplerBudget: number }) {
  const lowered = lowerMaterialDocument(document);
  if (!lowered.ok) throw new Error(lowered.diagnostics.map((row) => row.message).join("; "));
  return planDiagnostics(lowered.plan, samplerBudget);
}

/** A surface whose base color adds `count` samples, each with its own Texture or all fed by one Texture parameter. */
function sampled(count: number, shared: boolean): MaterialDocument {
  const doc = createDefaultMaterialDocument();
  doc.edges = doc.edges.filter((edge) => edge.id !== "e-color-output");
  doc.nodes.push({ id: "uv", type: "input.uv", position: { x: 0, y: 0 }, properties: {} });
  if (shared)
    doc.nodes.push({ id: "tex", type: "param.texture", position: { x: 0, y: 0 }, properties: { name: "Texture", textureGuid: "tex" } });
  let previous: { node: string; pin: string } | undefined;
  for (let index = 0; index < count; index++) {
    const sample = `sample${index}`;
    doc.nodes.push({
      id: sample,
      type: "texture.sample",
      position: { x: 0, y: 0 },
      properties: shared ? {} : { textureGuid: `tex-${index}` },
    });
    doc.edges.push({ id: `uv-${index}`, sourceNodeId: "uv", sourcePinId: "uv", targetNodeId: sample, targetPinId: "uv" });
    if (shared)
      doc.edges.push({ id: `tex-${index}`, sourceNodeId: "tex", sourcePinId: "out", targetNodeId: sample, targetPinId: "texture" });
    if (!previous) {
      previous = { node: sample, pin: "rgb" };
      continue;
    }
    const add = `add${index}`;
    doc.nodes.push({ id: add, type: "math.add", position: { x: 0, y: 0 }, properties: {} });
    doc.edges.push(
      { id: `${add}-a`, sourceNodeId: previous.node, sourcePinId: previous.pin, targetNodeId: add, targetPinId: "a" },
      { id: `${add}-b`, sourceNodeId: sample, sourcePinId: "rgb", targetNodeId: add, targetPinId: "b" },
    );
    previous = { node: add, pin: "out" };
  }
  doc.edges.push({ id: "e-out", sourceNodeId: previous!.node, sourcePinId: previous!.pin, targetNodeId: "output", targetPinId: "baseColor" });
  return doc;
}

describe("material sampler budget", () => {
  it("warns a lit Material that binds more samplers than fixed-shape lighting leaves it, at the first one over", () => {
    // Seven Textures and the scene environment's two samplers: nine.
    const diagnostics = materialSamplerBudgetDiagnostics(sampled(7, false), { samplerBudget: 8 });
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "material.samplerBudget", severity: "warning", nodeId: "sample6" }),
    ]);
    expect(diagnostics[0]!.message).toContain("binds 9 texture samplers");
    expect(materialSamplerBudgetDiagnostics(sampled(6, false), { samplerBudget: 8 })).toEqual([]);
  });

  it("counts one sampler for every sample of a Texture parameter", () => {
    expect(materialSamplerBudgetDiagnostics(sampled(12, true), { samplerBudget: 8 })).toEqual([]);
  });

  it("leaves unlit Materials alone, which take no scene lights", () => {
    const unlit = { ...sampled(12, false), shadingModel: "unlit" as const };
    expect(materialSamplerBudgetDiagnostics(unlit, { samplerBudget: 8 })).toEqual([]);
  });
});
