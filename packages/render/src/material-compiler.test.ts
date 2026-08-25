import { afterEach, describe, expect, it, vi } from "vitest";
import { Material, NullEngine, Scene, Texture, TextureBlock } from "@babylonjs/core";
import {
  createDefaultMaterialDocument,
  createDefaultMaterialFunctionDocument,
  lowerMaterialDocument,
  migrateLegacyShaderPayload,
  type MaterialDocument,
} from "@babylonslate/shader-graph";
import { compileMaterialPlan } from "./material-compiler";

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
});

function host(): Scene {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  disposers.push(() => {
    scene.dispose();
    engine.dispose();
  });
  return scene;
}

function planFor(doc: MaterialDocument, functions = {}) {
  const lowered = lowerMaterialDocument(doc, { functions });
  if (!lowered.ok) {
    throw new Error(
      `lowering failed: ${lowered.diagnostics.map((d) => d.code).join(", ")}`,
    );
  }
  return lowered.plan;
}

/** Base Color driven by a Multiply so the graph is not a bare constant. */
function multiplyMaterial(): MaterialDocument {
  const doc = createDefaultMaterialDocument();
  doc.nodes.push(
    {
      id: "tint",
      type: "const.vec3",
      position: { x: 0, y: 0 },
      properties: { value: [1, 0, 0] },
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

describe("material compiler", () => {
  it("builds a real NodeMaterial for a surface graph", () => {
    const scene = host();
    const result = compileMaterialPlan(planFor(createDefaultMaterialDocument()), {
      scene,
      name: "test",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    disposers.push(() => result.material.dispose());
    expect(result.material.getClassName()).toBe("NodeMaterial");
  });

  it("applies opaque blendMode as MATERIAL_OPAQUE after build, including unlit", () => {
    const scene = host();
    const pbr = compileMaterialPlan(planFor(createDefaultMaterialDocument()), {
      scene,
      name: "opaque-pbr",
    });
    expect(pbr.ok).toBe(true);
    if (!pbr.ok) return;
    disposers.push(() => pbr.material.dispose());
    expect(pbr.material.transparencyMode).toBe(Material.MATERIAL_OPAQUE);

    const unlitDoc = createDefaultMaterialDocument();
    unlitDoc.shadingModel = "unlit";
    const unlit = compileMaterialPlan(planFor(unlitDoc), {
      scene,
      name: "opaque-unlit",
    });
    expect(unlit.ok).toBe(true);
    if (!unlit.ok) return;
    disposers.push(() => unlit.material.dispose());
    expect(unlit.material.transparencyMode).toBe(Material.MATERIAL_OPAQUE);
  });

  it("applies masked and translucent blendMode plus two-sided culling", () => {
    const scene = host();
    const maskedDoc = createDefaultMaterialDocument();
    maskedDoc.blendMode = "masked";
    maskedDoc.alphaCutoff = 0.4;
    const masked = compileMaterialPlan(planFor(maskedDoc), {
      scene,
      name: "masked",
    });
    expect(masked.ok).toBe(true);
    if (!masked.ok) return;
    disposers.push(() => masked.material.dispose());
    expect(masked.material.transparencyMode).toBe(Material.MATERIAL_ALPHATEST);
    expect(
      (masked.material as unknown as { alphaCutOff: number }).alphaCutOff,
    ).toBeCloseTo(0.4);

    const glassDoc = createDefaultMaterialDocument();
    glassDoc.blendMode = "translucent";
    glassDoc.twoSided = true;
    const glass = compileMaterialPlan(planFor(glassDoc), {
      scene,
      name: "glass",
    });
    expect(glass.ok).toBe(true);
    if (!glass.ok) return;
    disposers.push(() => glass.material.dispose());
    expect(glass.material.transparencyMode).toBe(Material.MATERIAL_ALPHABLEND);
    expect(glass.material.needDepthPrePass).toBe(true);
    expect(glass.material.backFaceCulling).toBe(false);
  });

  it("compiles a particle-domain graph in Particle mode for createEffectForParticles", () => {
    const scene = host();
    const result = compileMaterialPlan(
      planFor(createDefaultMaterialDocument("Sparks", "particle")),
      { scene, name: "particle" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.diagnostics.map((row) => row.message).join(", "));
    }
    disposers.push(result.dispose);
    expect(result.material.mode).toBe(2);
    expect(
      result.material.attachedBlocks.some(
        (block) => block.getClassName() === "PBRMetallicRoughnessBlock",
      ),
    ).toBe(false);
    expect(
      result.material.attachedBlocks.some((block) => {
        const input = block as { isAttribute?: boolean; name?: string };
        return (
          input.isAttribute === true ||
          block.name.toLowerCase().includes("color")
        );
      }),
    ).toBe(true);
  });

  it("compiles Particle Texture as ParticleTextureBlock with particle_uv when UV is unwired", () => {
    const scene = host();
    const doc = createDefaultMaterialDocument("Sparks", "particle");
    doc.nodes.push({
      id: "tex",
      type: "input.particleTexture",
      position: { x: 0, y: 80 },
      properties: {},
    });
    doc.edges = [
      {
        id: "e-tex-output",
        sourceNodeId: "tex",
        sourcePinId: "rgba",
        targetNodeId: "output",
        targetPinId: "color",
      },
    ];
    const result = compileMaterialPlan(planFor(doc), {
      scene,
      name: "particleTexture",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.diagnostics.map((row) => row.message).join(", "));
    }
    disposers.push(result.dispose);
    expect(
      result.material.attachedBlocks.some(
        (block) => block.getClassName() === "ParticleTextureBlock",
      ),
    ).toBe(true);
  });

  it("instantiates a Babylon block per lowered operation", () => {
    const scene = host();
    const result = compileMaterialPlan(planFor(multiplyMaterial()), {
      scene,
      name: "test",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    disposers.push(() => result.material.dispose());
    const classNames = result.material.attachedBlocks.map((block) =>
      block.getClassName(),
    );
    expect(classNames).toContain("MultiplyBlock");
    // The two authored constants each become their own input block.
    expect(
      classNames.filter((name) => name === "InputBlock").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("connects the graph so the output block is actually fed", () => {
    const scene = host();
    const result = compileMaterialPlan(planFor(multiplyMaterial()), {
      scene,
      name: "test",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    disposers.push(() => result.material.dispose());
    const multiply = result.material.attachedBlocks.find(
      (block) => block.getClassName() === "MultiplyBlock",
    );
    expect(multiply?.inputs.every((input) => input.isConnected)).toBe(true);
    expect(multiply?.outputs[0]?.isConnected).toBe(true);
  });

  it("produces a different shader when the graph changes", () => {
    const scene = host();
    const flat = compileMaterialPlan(planFor(createDefaultMaterialDocument()), {
      scene,
      name: "flat",
    });
    const tinted = compileMaterialPlan(planFor(multiplyMaterial()), {
      scene,
      name: "tinted",
    });
    expect(flat.ok && tinted.ok).toBe(true);
    if (!flat.ok || !tinted.ok) return;
    disposers.push(() => flat.material.dispose());
    disposers.push(() => tinted.material.dispose());
    expect(flat.material.attachedBlocks.length).not.toBe(
      tinted.material.attachedBlocks.length,
    );
  });

  it("carries a constant value onto its input block", () => {
    const scene = host();
    const doc = createDefaultMaterialDocument();
    doc.nodes[0]!.properties = { value: [0.25, 0.5, 0.75, 1] };
    const result = compileMaterialPlan(planFor(doc), { scene, name: "test" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    disposers.push(() => result.material.dispose());
    const constants = result.material.attachedBlocks.filter(
      (block) => block.getClassName() === "InputBlock",
    );
    const authored = constants.find((block) => {
      const value = (block as unknown as { value?: { r?: number } }).value;
      return typeof value?.r === "number" && Math.abs(value.r - 0.25) < 1e-6;
    });
    expect(authored).toBeDefined();
  });

  it("builds a post-process material in post-process mode", () => {
    const scene = host();
    const doc = createDefaultMaterialDocument("Blur", "postProcess");
    const result = compileMaterialPlan(planFor(doc), { scene, name: "blur" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    disposers.push(() => result.material.dispose());
    // NodeMaterialModes.PostProcess
    expect(result.material.mode).toBe(1);
    expect(
      result.material.attachedBlocks.some(
        (block) => block.getClassName() === "CurrentScreenBlock",
      ),
    ).toBe(true);
  });

  it("samples linearized scene depth instead of fragment coordinates", () => {
    const scene = host();
    const doc = createDefaultMaterialDocument("Depth", "postProcess");
    doc.nodes.push({
      id: "depth",
      type: "input.sceneDepth",
      position: { x: 0, y: 0 },
      properties: {},
    });
    doc.edges.push({
      id: "e-uv-depth",
      sourceNodeId: "screenUv",
      sourcePinId: "uv",
      targetNodeId: "depth",
      targetPinId: "uv",
    });
    doc.nodes.push({
      id: "mul",
      type: "math.multiply",
      position: { x: 0, y: 0 },
      properties: {},
    });
    doc.edges = doc.edges.map((edge) =>
      edge.id === "e-scene-output"
        ? { ...edge, sourceNodeId: "mul", sourcePinId: "out" }
        : edge,
    );
    doc.edges.push(
      {
        id: "e-color-mul",
        sourceNodeId: "sceneColor",
        sourcePinId: "color",
        targetNodeId: "mul",
        targetPinId: "a",
      },
      {
        id: "e-depth-mul",
        sourceNodeId: "depth",
        sourcePinId: "depth",
        targetNodeId: "mul",
        targetPinId: "b",
      },
    );
    const result = compileMaterialPlan(planFor(doc), { scene, name: "depth" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    disposers.push(() => result.material.dispose());
    expect(
      result.material.attachedBlocks.some(
        (block) => block.getClassName() === "SceneDepthBlock",
      ),
    ).toBe(true);
    expect(
      result.material.attachedBlocks.some(
        (block) => block.getClassName() === "FragCoordBlock",
      ),
    ).toBe(false);
  });

  it("samples scene normals from a pre-pass texture", () => {
    const scene = host();
    const doc = createDefaultMaterialDocument("Normals", "postProcess");
    doc.nodes.push(
      {
        id: "normal",
        type: "input.sceneNormal",
        position: { x: 0, y: 0 },
        properties: {},
      },
      {
        id: "len",
        type: "vector.length",
        position: { x: 0, y: 0 },
        properties: {},
      },
      {
        id: "mul",
        type: "math.multiply",
        position: { x: 0, y: 0 },
        properties: {},
      },
    );
    doc.edges.push({
      id: "e-uv-normal",
      sourceNodeId: "screenUv",
      sourcePinId: "uv",
      targetNodeId: "normal",
      targetPinId: "uv",
    });
    doc.edges = doc.edges.map((edge) =>
      edge.id === "e-scene-output"
        ? { ...edge, sourceNodeId: "mul", sourcePinId: "out" }
        : edge,
    );
    doc.edges.push(
      {
        id: "e-color-mul",
        sourceNodeId: "sceneColor",
        sourcePinId: "color",
        targetNodeId: "mul",
        targetPinId: "a",
      },
      {
        id: "e-normal-len",
        sourceNodeId: "normal",
        sourcePinId: "normal",
        targetNodeId: "len",
        targetPinId: "value",
      },
      {
        id: "e-len-mul",
        sourceNodeId: "len",
        sourcePinId: "out",
        targetNodeId: "mul",
        targetPinId: "b",
      },
    );
    const result = compileMaterialPlan(planFor(doc), { scene, name: "normals" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    disposers.push(() => result.material.dispose());
    expect(
      result.material.attachedBlocks.some(
        (block) => block.getClassName() === "PrePassTextureBlock",
      ),
    ).toBe(true);
  });

  it("emits a vertex output so a surface material can build", () => {
    const scene = host();
    const result = compileMaterialPlan(planFor(createDefaultMaterialDocument()), {
      scene,
      name: "test",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    disposers.push(() => result.material.dispose());
    expect(
      result.material.attachedBlocks.some(
        (block) => block.getClassName() === "VertexOutputBlock",
      ),
    ).toBe(true);
  });

  it("uses a PBR block for the pbr shading model", () => {
    const scene = host();
    const result = compileMaterialPlan(planFor(createDefaultMaterialDocument()), {
      scene,
      name: "test",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    disposers.push(() => result.material.dispose());
    expect(
      result.material.attachedBlocks.some(
        (block) => block.getClassName() === "PBRMetallicRoughnessBlock",
      ),
    ).toBe(true);
  });

  it("skips the PBR block for an unlit material", () => {
    const scene = host();
    const doc = createDefaultMaterialDocument();
    doc.shadingModel = "unlit";
    const result = compileMaterialPlan(planFor(doc), { scene, name: "test" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    disposers.push(() => result.material.dispose());
    expect(
      result.material.attachedBlocks.some(
        (block) => block.getClassName() === "PBRMetallicRoughnessBlock",
      ),
    ).toBe(false);
  });

  it("composes fwidth from derivatives instead of custom source", () => {
    const scene = host();
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(
      {
        id: "fwUv",
        type: "input.uv",
        position: { x: 0, y: 0 },
        properties: {},
      },
      {
        id: "fwSplit",
        type: "vector.split",
        position: { x: 0, y: 0 },
        properties: {},
      },
      {
        id: "fw",
        type: "derivative.fwidth",
        position: { x: 0, y: 0 },
        properties: {},
      },
    );
    doc.edges.push(
      {
        id: "e-uv-split",
        sourceNodeId: "fwUv",
        sourcePinId: "uv",
        targetNodeId: "fwSplit",
        targetPinId: "value",
      },
      {
        id: "e-split-fw",
        sourceNodeId: "fwSplit",
        sourcePinId: "x",
        targetNodeId: "fw",
        targetPinId: "value",
      },
      {
        id: "e-fw-out",
        sourceNodeId: "fw",
        sourcePinId: "out",
        targetNodeId: "output",
        targetPinId: "metallic",
      },
    );
    const result = compileMaterialPlan(planFor(doc), { scene, name: "test" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    disposers.push(() => result.material.dispose());
    const names = result.material.attachedBlocks.map((block) =>
      block.getClassName(),
    );
    expect(names).toContain("DerivativeBlock");
    expect(names).not.toContain("CustomBlock");
  });

  it("realizes Custom GLSL through a Babylon CustomBlock", () => {
    const scene = host();
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({
      id: "glsl",
      type: "custom.glsl",
      position: { x: 0, y: 0 },
      properties: { body: "a + b" },
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
    const result = compileMaterialPlan(planFor(doc), { scene, name: "test" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    disposers.push(() => result.material.dispose());
    expect(
      result.material.attachedBlocks.map((block) => block.getClassName()),
    ).toContain("CustomBlock");
  });

  it("resolves a texture through the injected texture provider", () => {
    const scene = host();
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(
      {
        id: "tex",
        type: "param.texture",
        position: { x: 0, y: 0 },
        properties: { textureGuid: "tex-1" },
      },
      {
        id: "texUv",
        type: "input.uv",
        position: { x: 0, y: 0 },
        properties: {},
      },
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
        sourceNodeId: "texUv",
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
    const requested: string[] = [];
    const resolved = new Texture(null, scene, true, false);
    disposers.push(() => resolved.dispose());
    const result = compileMaterialPlan(planFor(doc), {
      scene,
      name: "test",
      resolveTexture: (guid) => {
        requested.push(guid);
        return resolved;
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    disposers.push(() => result.material.dispose());
    expect(requested).toEqual(["tex-1"]);
    expect(
      result.material.attachedBlocks.some(
        (block) => block.getClassName() === "TextureBlock",
      ),
    ).toBe(true);
  });

  it("binds an inline Texture asset when no texture parameter is wired", () => {
    const scene = host();
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(
      {
        id: "texUv",
        type: "input.uv",
        position: { x: 0, y: 0 },
        properties: {},
      },
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
        sourceNodeId: "texUv",
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
    const requested: string[] = [];
    const resolved = new Texture(null, scene, true, false);
    disposers.push(() => resolved.dispose());
    const result = compileMaterialPlan(planFor(doc), {
      scene,
      name: "test",
      resolveTexture: (guid) => {
        requested.push(guid);
        return resolved;
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    disposers.push(() => result.material.dispose());
    expect(requested).toEqual(["tex-inline"]);
  });

  it("samples an inline Texture on mesh UVs when UV is unwired", () => {
    const scene = host();
    const resolved = new Texture(null, scene, true, false);
    disposers.push(() => resolved.dispose());
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
    const result = compileMaterialPlan(planFor(doc), {
      scene,
      name: "test",
      resolveTexture: () => resolved,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.diagnostics.map((row) => row.message).join(", "));
    }
    disposers.push(() => result.material.dispose());
    const sample = result.material.attachedBlocks.find(
      (block) => block.getClassName() === "TextureBlock",
    ) as TextureBlock | undefined;
    expect(sample?.texture).toBe(resolved);
    expect(sample?.uv.isConnected).toBe(true);
    const uvSource = sample?.uv.connectedPoint?.ownerBlock as
      | { isAttribute?: boolean; name?: string }
      | undefined;
    expect(uvSource?.isAttribute).toBe(true);
    expect(uvSource?.name).toMatch(/uv/i);
  });

  it("samples an inline Texture on screen UVs in a post-process material", () => {
    const scene = host();
    const resolved = new Texture(null, scene, true, false);
    disposers.push(() => resolved.dispose());
    const doc = createDefaultMaterialDocument("Bloom", "postProcess");
    doc.nodes.push({
      id: "sample",
      type: "texture.sample",
      position: { x: 0, y: 0 },
      properties: { textureGuid: "tex-inline" },
    });
    doc.edges = [
      {
        id: "e-sample",
        sourceNodeId: "sample",
        sourcePinId: "rgba",
        targetNodeId: "output",
        targetPinId: "color",
      },
    ];
    const result = compileMaterialPlan(planFor(doc), {
      scene,
      name: "bloom",
      resolveTexture: () => resolved,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.diagnostics.map((row) => row.message).join(", "));
    }
    disposers.push(() => result.material.dispose());
    const sample = result.material.attachedBlocks.find(
      (block) => block.getClassName() === "TextureBlock",
    ) as TextureBlock | undefined;
    expect(sample?.texture).toBe(resolved);
    expect(sample?.uv.isConnected).toBe(true);
    expect(sample?.uv.connectedPoint?.ownerBlock.name).toMatch(/screenUv/i);
  });

  it("keeps an authored Transform UV connection instead of the mesh UV default", () => {
    const scene = host();
    const resolved = new Texture(null, scene, true, false);
    disposers.push(() => resolved.dispose());
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(
      {
        id: "sample",
        type: "texture.sample",
        position: { x: 0, y: 0 },
        properties: { textureGuid: "tex-inline" },
      },
      {
        id: "xform",
        type: "texture.transformUv",
        position: { x: 0, y: 0 },
        properties: {},
      },
    );
    doc.edges = doc.edges.filter((edge) => edge.id !== "e-color-output");
    doc.edges.push(
      {
        id: "e-xform",
        sourceNodeId: "xform",
        sourcePinId: "out",
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
    const result = compileMaterialPlan(planFor(doc), {
      scene,
      name: "test",
      resolveTexture: () => resolved,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.diagnostics.map((row) => row.message).join(", "));
    }
    disposers.push(() => result.material.dispose());
    const sample = result.material.attachedBlocks.find(
      (block) => block.getClassName() === "TextureBlock",
    ) as TextureBlock | undefined;
    expect(sample?.uv.connectedPoint?.ownerBlock.getClassName()).toBe("AddBlock");
  });

  it("reports a missing Texture when the provider cannot resolve the guid", () => {
    const scene = host();
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({
      id: "sample",
      type: "texture.sample",
      position: { x: 0, y: 0 },
      properties: { textureGuid: "gone" },
    });
    doc.edges = doc.edges.filter((edge) => edge.id !== "e-color-output");
    doc.edges.push({
      id: "e-sample",
      sourceNodeId: "sample",
      sourcePinId: "rgb",
      targetNodeId: "output",
      targetPinId: "baseColor",
    });
    const result = compileMaterialPlan(planFor(doc), {
      scene,
      name: "test",
      resolveTexture: () => null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((row) => row.code)).toContain(
      "material.missingTexture",
    );
  });

  it("reports a disposed Texture the same as a missing one", () => {
    const scene = host();
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({
      id: "sample",
      type: "texture.sample",
      position: { x: 0, y: 0 },
      properties: { textureGuid: "tex-1" },
    });
    doc.edges = doc.edges.filter((edge) => edge.id !== "e-color-output");
    doc.edges.push({
      id: "e-sample",
      sourceNodeId: "sample",
      sourcePinId: "rgb",
      targetNodeId: "output",
      targetPinId: "baseColor",
    });
    const disposed = new Texture(null, scene, true, false);
    disposed.dispose();
    const result = compileMaterialPlan(planFor(doc), {
      scene,
      name: "test",
      resolveTexture: () => disposed,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((row) => row.code)).toContain(
      "material.missingTexture",
    );
  });

  it("assigns the Texture Parameter asset onto the sampling TextureBlock", () => {
    const scene = host();
    const resolved = new Texture(null, scene, true, false);
    disposers.push(() => resolved.dispose());
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(
      {
        id: "tex",
        type: "param.texture",
        position: { x: 0, y: 0 },
        properties: { textureGuid: "tex-1" },
      },
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
        id: "e-sample",
        sourceNodeId: "sample",
        sourcePinId: "rgb",
        targetNodeId: "output",
        targetPinId: "baseColor",
      },
    );
    const result = compileMaterialPlan(planFor(doc), {
      scene,
      name: "test",
      resolveTexture: (guid) => (guid === "tex-1" ? resolved : null),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.diagnostics.map((row) => row.message).join(", "));
    }
    disposers.push(() => result.material.dispose());
    const sample = result.material.attachedBlocks.find(
      (block) => block.getClassName() === "TextureBlock",
    ) as TextureBlock | undefined;
    expect(sample?.texture).toBe(resolved);
  });

  it("rebuilds the NodeMaterial when a packed Texture Parameter becomes ready", () => {
    const scene = host();
    const resolved = new Texture(null, scene, true, false);
    disposers.push(() => resolved.dispose());
    let ready = false;
    vi.spyOn(resolved, "isReady").mockImplementation(() => ready);
    const doc = migrateLegacyShaderPayload({}, { textureGuids: ["tex-1"] });
    const result = compileMaterialPlan(planFor(doc), {
      scene,
      name: "imported-albedo",
      resolveTexture: (guid) => (guid === "tex-1" ? resolved : null),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.diagnostics.map((row) => row.message).join(", "));
    }
    disposers.push(() => result.material.dispose());
    const rebuild = vi.spyOn(result.material, "build");
    ready = true;
    resolved.onLoadObservable.notifyObservers(resolved);
    expect(rebuild).toHaveBeenCalled();
  });

  it("keeps invertY false on the compiled sampling TextureBlock", () => {
    const scene = host();
    const resolved = new Texture(null, scene, true, false);
    disposers.push(() => resolved.dispose());
    expect(resolved.invertY).toBe(false);
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(
      {
        id: "tex",
        type: "param.texture",
        position: { x: 0, y: 0 },
        properties: { textureGuid: "tex-1" },
      },
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
        id: "e-sample",
        sourceNodeId: "sample",
        sourcePinId: "rgb",
        targetNodeId: "output",
        targetPinId: "baseColor",
      },
    );
    const result = compileMaterialPlan(planFor(doc), {
      scene,
      name: "test",
      resolveTexture: (guid) => (guid === "tex-1" ? resolved : null),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.diagnostics.map((row) => row.message).join(", "));
    }
    disposers.push(() => result.material.dispose());
    const sample = result.material.attachedBlocks.find(
      (block) => block.getClassName() === "TextureBlock",
    ) as TextureBlock | undefined;
    expect(sample?.texture).toBe(resolved);
    expect(sample?.texture?.invertY).toBe(false);
  });

  it("inlines a material function into the same block graph", () => {
    const scene = host();
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
    const result = compileMaterialPlan(
      planFor(doc, { "fn-tint": fn }),
      { scene, name: "test" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    disposers.push(() => result.material.dispose());
    expect(
      result.material.attachedBlocks.filter(
        (block) => block.getClassName() === "MultiplyBlock",
      ).length,
    ).toBe(1);
  });

  it("reports a diagnostic anchored to the node when a block fails", () => {
    const scene = host();
    const plan = planFor(createDefaultMaterialDocument());
    plan.operations.push({
      id: "broken",
      nodeType: "math.notARealNode",
      resolvedType: "float",
      inputs: {},
      properties: {},
      source: { nodeId: "broken", callPath: [] },
    });
    const result = compileMaterialPlan(plan, { scene, name: "test" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]?.nodeId).toBe("broken");
  });

  it("maps a failure inside a function back to the call node", () => {
    const scene = host();
    const plan = planFor(createDefaultMaterialDocument());
    plan.operations.push({
      id: "call/broken",
      nodeType: "math.notARealNode",
      resolvedType: "float",
      inputs: {},
      properties: {},
      source: { nodeId: "broken", callPath: ["call"], functionGuid: "fn-1" },
    });
    const result = compileMaterialPlan(plan, { scene, name: "test" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]?.nodeId).toBe("call");
  });

  it("disposes every block it created when the result is disposed", () => {
    const scene = host();
    const before = scene.materials.length;
    const result = compileMaterialPlan(planFor(multiplyMaterial()), {
      scene,
      name: "test",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(scene.materials.length).toBe(before + 1);
    result.dispose();
    expect(scene.materials.length).toBe(before);
  });

  it("is idempotent when disposed twice", () => {
    const scene = host();
    const result = compileMaterialPlan(planFor(multiplyMaterial()), {
      scene,
      name: "test",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    result.dispose();
    expect(() => result.dispose()).not.toThrow();
  });

  it("skips a World Position Offset add when the channel is the zero default", () => {
    const scene = host();
    const result = compileMaterialPlan(planFor(createDefaultMaterialDocument()), {
      scene,
      name: "test",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    disposers.push(() => result.material.dispose());
    expect(
      result.material.attachedBlocks.some((block) =>
        block.name.includes("worldPosOffset"),
      ),
    ).toBe(false);
  });

  it("adds a world-space offset into the clip chain for a constant lift", () => {
    const scene = host();
    const doc = createDefaultMaterialDocument();
    const output = doc.nodes.find((node) => node.type === "output.surface");
    expect(output).toBeDefined();
    output!.properties = { "default:worldPositionOffset": [0, 1, 0] };
    const result = compileMaterialPlan(planFor(doc), { scene, name: "lift" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    disposers.push(() => result.material.dispose());
    expect(
      result.material.attachedBlocks.some(
        (block) =>
          block.getClassName() === "AddBlock" &&
          block.name.includes("worldPosOffset"),
      ),
    ).toBe(true);
    const clip = result.material.attachedBlocks.find((block) =>
      block.name.endsWith("_clipPos"),
    );
    expect(clip?.inputs[0]?.isConnected).toBe(true);
  });

  it("builds a Time and Sine graph wired into World Position Offset", () => {
    const scene = host();
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
    const result = compileMaterialPlan(planFor(doc), { scene, name: "waves" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    disposers.push(() => result.material.dispose());
    const names = result.material.attachedBlocks.map((block) =>
      block.getClassName(),
    );
    expect(names).toContain("TrigonometryBlock");
    expect(
      result.material.attachedBlocks.some(
        (block) =>
          block.getClassName() === "AddBlock" &&
          block.name.includes("worldPosOffset"),
      ),
    ).toBe(true);
  });

  it("builds when World Position feeds World Position Offset", () => {
    const scene = host();
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({
      id: "worldPos",
      type: "input.worldPosition",
      position: { x: 0, y: 0 },
      properties: {},
    });
    doc.edges.push({
      id: "e-world-wpo",
      sourceNodeId: "worldPos",
      sourcePinId: "position",
      targetNodeId: "output",
      targetPinId: "worldPositionOffset",
    });
    const result = compileMaterialPlan(planFor(doc), {
      scene,
      name: "fromWorld",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    disposers.push(() => result.material.dispose());
    expect(
      result.material.attachedBlocks.some(
        (block) => block.getClassName() === "VertexOutputBlock",
      ),
    ).toBe(true);
  });

  it("reads fragment World Position from the displaced tap", () => {
    const scene = host();
    const doc = createDefaultMaterialDocument();
    const output = doc.nodes.find((node) => node.type === "output.surface");
    expect(output).toBeDefined();
    output!.properties = { "default:worldPositionOffset": [0, 1, 0] };
    doc.nodes.push({
      id: "worldPos",
      type: "input.worldPosition",
      position: { x: 0, y: 0 },
      properties: {},
    });
    doc.edges = doc.edges.filter((edge) => edge.id !== "e-color-output");
    doc.edges.push({
      id: "e-world-color",
      sourceNodeId: "worldPos",
      sourcePinId: "position",
      targetNodeId: "output",
      targetPinId: "baseColor",
    });
    const result = compileMaterialPlan(planFor(doc), { scene, name: "foam" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    disposers.push(() => result.material.dispose());
    const displaced = result.material.attachedBlocks.find((block) =>
      block.name.endsWith("_worldPosDisplaced"),
    );
    const splitter = result.material.attachedBlocks.find(
      (block) => block.name === "worldPos_xyz",
    );
    expect(displaced).toBeDefined();
    expect(splitter).toBeDefined();
    const source = splitter?.inputs[0]?.connectedPoint?.ownerBlock;
    expect(source?.name).toBe(displaced?.name);
  });
});
