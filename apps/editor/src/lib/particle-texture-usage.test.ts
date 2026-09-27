import { describe, expect, it } from "vitest";
import {
  createDefaultMaterialDocument,
  createDefaultMaterialFunctionDocument,
  type MaterialDocument,
} from "@babylonslate/shader-graph";
import {
  PARTICLE_TEXTURE_USAGE_CODE,
  particleMaterialTextureSamples,
  particleTextureUsageWarnings,
} from "./particle-texture-usage";

/** Particle Material: `sample` feeds the output; `unused` is not wired. */
function sparksMaterial(): MaterialDocument {
  const doc = createDefaultMaterialDocument("Sparks", "particle");
  doc.nodes.push(
    { id: "sample", type: "texture.sample", position: { x: 0, y: 0 }, properties: { textureGuid: "tex-spark" } },
    { id: "unused", type: "texture.sample", position: { x: 0, y: 0 }, properties: { textureGuid: "tex-unused" } },
  );
  doc.edges = [
    { id: "e-sample-output", sourceNodeId: "sample", sourcePinId: "rgba", targetNodeId: "output", targetPinId: "color" },
  ];
  return doc;
}

function texture(name: string, payload: Record<string, unknown>) {
  return { path: `assets/${name}.babasset`, header: { type: "Texture", name, payload } };
}

describe("particleMaterialTextureSamples", () => {
  it("lists only Textures the output reaches, anchored to their node", () => {
    expect(particleMaterialTextureSamples(sparksMaterial(), {})).toEqual([
      { textureGuid: "tex-spark", nodeId: "sample" },
    ]);
  });

  it("anchors a Texture sampled inside a Material Function to the call node", () => {
    const fn = createDefaultMaterialFunctionDocument("Glow");
    fn.inputs = [];
    fn.nodes.push({ id: "inner", type: "texture.sample", position: { x: 0, y: 0 }, properties: { textureGuid: "tex-glow" } });
    fn.edges = [
      { id: "e-inner-out", sourceNodeId: "inner", sourcePinId: "rgb", targetNodeId: "outputs", targetPinId: "out_value" },
    ];
    const doc = createDefaultMaterialDocument("Glow", "particle");
    doc.nodes.push({ id: "call", type: "function.call", position: { x: 0, y: 0 }, properties: { functionGuid: "fn-glow" } });
    doc.edges = [
      { id: "e-call-output", sourceNodeId: "call", sourcePinId: "out_value", targetNodeId: "output", targetPinId: "color" },
    ];
    expect(particleMaterialTextureSamples(doc, { "fn-glow": fn })).toEqual([
      { textureGuid: "tex-glow", nodeId: "call" },
    ]);
  });

  it("falls back to the Material's own texture nodes, on request, when it does not lower", () => {
    const doc = sparksMaterial();
    doc.nodes.push({ id: "bogus", type: "math.doesNotExist", position: { x: 0, y: 0 }, properties: {} });
    expect(particleMaterialTextureSamples(doc, {})).toEqual([]);
    expect(particleMaterialTextureSamples(doc, {}, { whenInvalid: "nodes" })).toEqual([
      { textureGuid: "tex-spark", nodeId: "sample" },
      { textureGuid: "tex-unused", nodeId: "unused" },
    ]);
  });

  it("ignores Materials outside the Particle domain", () => {
    expect(particleMaterialTextureSamples({ ...sparksMaterial(), domain: "surface" }, {})).toEqual([]);
  });
});

describe("particleTextureUsageWarnings", () => {
  it("warns once per Texture that needs Particle Usage, with its encoded size", () => {
    const assets: Record<string, ReturnType<typeof texture> | { path: string; header: { type: string; name: string } }> = {
      "tex-odd": texture("Spark", { usage: "albedo", width: 30, height: 30 }),
      "tex-aligned": texture("Smoke", { usage: "albedo", width: 32, height: 32 }),
      "tex-particle": texture("Ember", { usage: "particle", width: 30, height: 30 }),
      "model-1": { path: "assets/Statue.babasset", header: { type: "Model", name: "Statue" } },
    };
    const warnings = particleTextureUsageWarnings(
      [
        { textureGuid: "tex-odd", nodeId: "a" },
        { textureGuid: "tex-odd", nodeId: "b" },
        { textureGuid: "tex-aligned", nodeId: "c" },
        { textureGuid: "tex-particle", nodeId: "d" },
        { textureGuid: "model-1", nodeId: "e" },
        { textureGuid: "tex-missing", nodeId: "f" },
      ],
      { textureByGuid: (guid) => assets[guid], openDocuments: [], projectMax: 2048 },
    );
    expect(warnings).toEqual([
      {
        code: PARTICLE_TEXTURE_USAGE_CODE,
        severity: "warning",
        message: 'Texture "Spark" is 30×30; set its Usage to Particle so it loads on WebGPU.',
        textureGuid: "tex-odd",
        textureName: "Spark",
        nodeId: "a",
        width: 30,
        height: 30,
      },
    ]);
  });

  it("reads an open Texture tab's Usage and Downsample before the saved header", () => {
    const assets = {
      "tex-downsampled": texture("Smoke", { usage: "albedo", width: 1000, height: 752 }),
      "tex-fixed": texture("Spark", { usage: "albedo", width: 1, height: 1 }),
    };
    const warnings = particleTextureUsageWarnings(
      [{ textureGuid: "tex-downsampled" }, { textureGuid: "tex-fixed" }],
      {
        textureByGuid: (guid) => assets[guid as keyof typeof assets],
        openDocuments: [
          { ref: { kind: "texture", path: "assets/Smoke.babasset" }, content: { usage: "albedo", width: 1000, height: 752, downsample: 8 } },
          { ref: { kind: "texture", path: "assets/Spark.babasset" }, content: { usage: "particle", width: 1, height: 1 } },
        ],
        projectMax: 2048,
      },
    );
    expect(warnings.map(({ textureGuid, width, height }) => ({ textureGuid, width, height }))).toEqual([
      { textureGuid: "tex-downsampled", width: 125, height: 94 },
    ]);
  });
});
