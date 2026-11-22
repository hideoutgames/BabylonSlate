import { afterEach, describe, expect, it } from "vitest";
import { Constants } from "@babylonjs/core/Engines/constants";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Material } from "@babylonjs/core/Materials/material";
import type { Effect } from "@babylonjs/core/Materials/effect";
import type { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { Scene } from "@babylonjs/core/scene";
import { createDefaultMaterialDocument, lowerMaterialDocument, type MaterialDocument } from "@haptic/shader-graph";
import { DecalProjectionBlock, decalProjectionFragmentSource } from "./decal-projection-block";
import { isDrawBatchMaterial } from "./draw-batch-world-block";
import { HapticLightingBlock } from "./haptic-lighting-block";
import { setTargetedLayerScene } from "./layer-composite";
import { compileMaterialPlan } from "./material-compiler";
import { LayerMultiplyBlock, MultiplyBlendFactorBlock } from "./multiply-blend-block";
import { SceneFogBlock } from "./scene-fog-block";

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
});

function scene(): Scene {
  const engine = new NullEngine();
  const host = new Scene(engine);
  disposers.push(() => { host.dispose(); engine.dispose(); });
  return host;
}

function decalDocument(settings: Partial<MaterialDocument> = {}): MaterialDocument {
  return { ...createDefaultMaterialDocument("Decal", "decal"), ...settings };
}

async function compile(doc: MaterialDocument, name = "decal") {
  const lowered = lowerMaterialDocument(doc);
  if (!lowered.ok) throw new Error(lowered.diagnostics.map((row) => row.code).join(", "));
  const compiled = compileMaterialPlan(lowered.plan, { scene: scene(), name });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  expect(await compiled.ready).toEqual([]);
  disposers.push(() => compiled.dispose());
  return compiled.material;
}

/** The source of the GLSL function `name` in `source`, from its signature to its closing brace. */
function glslFunction(source: string, name: string): string {
  const start = source.search(new RegExp(`\\b\\w+\\s+${name}\\s*\\(`));
  expect(start, name).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let index = source.indexOf("{", start); index < source.length; index++) {
    if (source[index] === "{") depth++;
    else if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} is not closed`);
}

describe("Decal Material compile", () => {
  // Source-text contract: no GPU here runs D3D11's HLSL compiler. On Windows (ANGLE D3D11) an early `return` in a decal
  // helper function crashed the GPU process while the lit decal program linked, losing the WebGL context in Play.
  it("writes the projection inline in main, and leaves each fog helper by one final return", async () => {
    const projection = decalProjectionFragmentSource();
    expect(projection).not.toMatch(/\breturn\b/);
    // No helper function of its own: a definition would be a type, a name and an opening brace.
    expect(projection).not.toMatch(/\b(?:void|float|vec[234]|mat[34])\s+\w+\s*\([^)]*\)\s*\{/);
    const material = await compile(decalDocument());
    const fragment = material.compiledShaders.split("// Fragment shader")[1]!;
    expect(fragment).toContain("decalSceneDepth");
    for (const name of ["sceneFogKeep", "CalcFogFactor"]) {
      const helper = glslFunction(fragment, name);
      expect(helper.match(/\breturn\b/g), name).toHaveLength(1);
      expect(helper.trimEnd(), name).toMatch(/return [^;]+;\s*\}$/);
    }
  });

  it("compiles the hidden projection and the shared light block, alpha-blended, with the Material's alpha mode", async () => {
    const lit = await compile(decalDocument({ blendMode: "translucent" }), "lit");
    expect(lit.attachedBlocks.some((block) => block instanceof DecalProjectionBlock)).toBe(true);
    expect(lit.attachedBlocks.some((block) => block instanceof HapticLightingBlock)).toBe(true);
    expect(lit.transparencyMode).toBe(Material.MATERIAL_ALPHABLEND);
    expect(lit.alphaMode).toBe(Constants.ALPHA_COMBINE);
    expect(lit.metadata).toMatchObject({ materialDomain: "decal" });

    const unlit = await compile(decalDocument({ shadingModel: "unlit", blendMode: "additive" }), "unlit");
    expect(unlit.attachedBlocks.some((block) => block instanceof HapticLightingBlock)).toBe(false);
    expect(unlit.alphaMode).toBe(Constants.ALPHA_ADD);
    // Additive fades into the fog toward black (adding nothing), not toward the fog colour.
    expect(unlit.attachedBlocks.find((block): block is SceneFogBlock => block instanceof SceneFogBlock)?.toward).toBe("black");

    const expectations: Array<[MaterialDocument["blendMode"], number]> = [
      ["opaque", Constants.ALPHA_DISABLE], ["masked", Constants.ALPHA_DISABLE], ["multiply", Constants.ALPHA_MULTIPLY],
    ];
    for (const [blendMode, alphaMode] of expectations) {
      const material = await compile(decalDocument({ shadingModel: "unlit", blendMode }), blendMode);
      expect(material.alphaMode, blendMode).toBe(alphaMode);
      // Every blend mode is alpha-blended for the light block, so Screen-Space Shadows never split the program.
      expect(material.transparencyMode, blendMode).toBe(Material.MATERIAL_ALPHABLEND);
    }
  });

  it("compiles a normal-mapped Decal Material, wired or unwired UV, with the frame's UV negated on the box's back faces", async () => {
    for (const wired of [false, true]) {
      const doc = decalDocument();
      doc.nodes.push({ id: "map", type: "shading.normalMap", position: { x: 0, y: 0 }, properties: {} });
      doc.edges.push({ id: "map-normal", sourceNodeId: "map", sourcePinId: "normal", targetNodeId: "output", targetPinId: "normal" });
      if (wired) {
        doc.nodes.push({ id: "uv", type: "input.uv", position: { x: 0, y: 0 }, properties: {} });
        doc.edges.push({ id: "uv-map", sourceNodeId: "uv", sourcePinId: "uv", targetNodeId: "map", targetPinId: "uv" });
      }
      const material = await compile(doc, wired ? "wiredMap" : "map");
      expect(material.getBlockByName(wired ? "wiredMap_map_backFaceUv" : "map_map_backFaceUv") ?? material.attachedBlocks.find((block) => block.name.endsWith("_backFaceUv"))).toBeTruthy();
    }
  });

  it("writes a Multiply decal's factor, toward 1 in fog, and keeps a Per Instance parameter a uniform", async () => {
    const doc = decalDocument({ shadingModel: "unlit", blendMode: "multiply" });
    doc.nodes.push({ id: "tint", type: "param.color", position: { x: 0, y: 0 }, properties: { name: "Tint", value: [1, 0, 0, 1], perInstance: true } });
    doc.edges = [{ id: "tint-base", sourceNodeId: "tint", sourcePinId: "rgb", targetNodeId: "output", targetPinId: "baseColor" }];
    const material = await compile(doc, "multiply");
    expect(material.attachedBlocks.some((block) => block instanceof MultiplyBlendFactorBlock)).toBe(true);
    expect(material.attachedBlocks.find((block): block is SceneFogBlock => block instanceof SceneFogBlock)?.toward).toBe("white");
    // The box carries only the decal's own rows, so a Per Instance parameter reads its uniform.
    const vertex = material.compiledShaders.split("// Fragment shader")[0]!;
    expect(vertex).not.toMatch(/instanceParameter/);
  });
});

describe("Scene Layer Multiply", () => {
  async function compiled(doc: MaterialDocument, host: Scene, name: string, overlay: boolean) {
    const lowered = lowerMaterialDocument(doc);
    if (!lowered.ok) throw new Error("did not lower");
    const result = compileMaterialPlan(lowered.plan, { scene: host, name, overlay });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(await result.ready).toEqual([]);
    disposers.push(() => result.dispose());
    return result.material;
  }

  /** The value a draw binds for the layer kind's uniform. */
  function boundKind(material: NodeMaterial): number {
    const block = material.attachedBlocks.find((entry): entry is LayerMultiplyBlock => entry instanceof LayerMultiplyBlock)!;
    let value = Number.NaN;
    block.bind({ setFloat: (_name: string, bound: number) => { value = bound; } } as unknown as Effect, material);
    return value;
  }

  const fragmentOf = (material: NodeMaterial) => material.compiledShaders.split("// Fragment shader")[1]!;
  const lineOf = (fragment: string, pattern: RegExp) => fragment.split("\n").find((row) => pattern.test(row)) ?? "";
  const ui = { ...createDefaultMaterialDocument("Stain", "ui"), blendMode: "multiply" as const };

  it("blends a User Interface Multiply by its layer's kind with one program, and draws it in batches", async () => {
    const host = scene();
    const material = await compiled(ui, host, "ui", true);
    expect(material.attachedBlocks.some((block) => block instanceof LayerMultiplyBlock)).toBe(true);
    // A draw batch reproduces it: the layer kind is the Scene's, shared by every member.
    expect(isDrawBatchMaterial(material)).toBe(true);
    const program = material.getEffect();
    expect(material.alphaMode).toBe(Constants.ALPHA_MULTIPLY);
    expect(boundKind(material)).toBe(0);
    setTargetedLayerScene(host, true);
    expect(material.alphaMode).toBe(Constants.ALPHA_PREMULTIPLIED_PORTERDUFF);
    expect(boundKind(material)).toBe(1);
    // Writes cannot move it off its layer's kind.
    material.alphaMode = Constants.ALPHA_COMBINE;
    expect(material.alphaMode).toBe(Constants.ALPHA_PREMULTIPLIED_PORTERDUFF);
    setTargetedLayerScene(host, false);
    expect(material.alphaMode).toBe(Constants.ALPHA_MULTIPLY);
    expect(boundKind(material)).toBe(0);
    // The switch changes a uniform and the blend, never the program.
    expect(material.getEffect()).toBe(program);
  });

  // Source-text contract: the GPU shows the colours (the perf route's pictures); here, what each kind writes, that the
  // output encodes a linear factor once, and that the block keeps to main with no early exit (ANGLE's D3D11 translator).
  it("writes the factor with alpha 0 for a direct layer and its displayed grey's complement for a targeted one", async () => {
    const fragment = fragmentOf(await compiled(ui, scene(), "ui", true));
    expect(lineOf(fragment, /vec3 layerMultiplyFactor\w* =/)).toMatch(/= max\(mix\(vec3\(1\.0\), \w+\.rgb, clamp\(\w+, 0\.0, 1\.0\)\), vec3\(0\.0\)\);/);
    expect(lineOf(fragment, /float layerMultiplyGrey\w* =/)).toMatch(/clamp\(dot\(toGammaSpace\(layerMultiplyFactor\w*\), vec3\(0\.2126, 0\.7152, 0\.0722\)\), 0\.0, 1\.0\);/);
    expect(lineOf(fragment, /= mix\(vec4\(layerMultiplyFactor/)).toMatch(/mix\(vec4\(layerMultiplyFactor\w*, 0\.0\), vec4\(0\.0, 0\.0, 0\.0, 1\.0 - layerMultiplyGrey\w*\), layerTargeted\w*\);/);
    const main = fragment.slice(fragment.indexOf("void main"));
    expect(main.slice(0, main.indexOf("layerTargeted") + 200)).not.toMatch(/\breturn\b/);
  });

  it("gives a Text Material Multiply over its fill, glyph coverage and style, in display colour", async () => {
    const host = scene();
    const text = await compiled({ ...createDefaultMaterialDocument("Ink", "text"), blendMode: "multiply" }, host, "text", true);
    const block = text.attachedBlocks.find((entry): entry is LayerMultiplyBlock => entry instanceof LayerMultiplyBlock);
    expect(block?.linearInput).toBe(false);
    expect(text.alphaMode).toBe(Constants.ALPHA_MULTIPLY);
    setTargetedLayerScene(host, true);
    expect(text.alphaMode).toBe(Constants.ALPHA_PREMULTIPLIED_PORTERDUFF);
    setTargetedLayerScene(host, false);
    // Already display colour: the grey reads it as it is.
    expect(lineOf(fragmentOf(text), /float layerMultiplyGrey\w* =/)).toMatch(/clamp\(dot\(layerMultiplyFactor\w*, vec3/);
  });

  it("multiplies the world by a Surface factor, and blends a Surface on a layer mesh by the layer's kind", async () => {
    const doc = { ...createDefaultMaterialDocument("Stain"), shadingModel: "unlit" as const, blendMode: "multiply" as const };
    const host = scene();
    const world = await compiled(doc, host, "world", false);
    expect(world.alphaMode).toBe(Constants.ALPHA_MULTIPLY);
    expect(world.attachedBlocks.some((block) => block instanceof MultiplyBlendFactorBlock)).toBe(true);
    expect(world.attachedBlocks.some((block) => block instanceof LayerMultiplyBlock)).toBe(false);
    const overlay = await compiled(doc, host, "overlay", true);
    expect(overlay.attachedBlocks.some((block) => block instanceof MultiplyBlendFactorBlock)).toBe(false);
    expect(overlay.attachedBlocks.some((block) => block instanceof LayerMultiplyBlock)).toBe(true);
    setTargetedLayerScene(host, true);
    expect(world.alphaMode).toBe(Constants.ALPHA_MULTIPLY);
    expect(overlay.alphaMode).toBe(Constants.ALPHA_PREMULTIPLIED_PORTERDUFF);
    setTargetedLayerScene(host, false);
  });

  it("leaves Translucent and Additive Materials as they were on either layer kind", async () => {
    const host = scene();
    setTargetedLayerScene(host, true);
    const cases: Array<[MaterialDocument, boolean, number]> = [
      [createDefaultMaterialDocument("Panel", "ui"), true, Constants.ALPHA_COMBINE],
      [{ ...createDefaultMaterialDocument("Glow", "ui"), blendMode: "additive" }, true, Constants.ALPHA_ADD],
      [createDefaultMaterialDocument("Label", "text"), true, Constants.ALPHA_COMBINE],
      [{ ...createDefaultMaterialDocument("Shine", "text"), blendMode: "additive" }, true, Constants.ALPHA_ADD],
      [{ ...createDefaultMaterialDocument("Glass"), shadingModel: "unlit", blendMode: "translucent" }, true, Constants.ALPHA_COMBINE],
    ];
    for (const [doc, overlay, alphaMode] of cases) {
      const material = await compiled(doc, host, doc.name, overlay);
      expect(material.alphaMode, doc.name).toBe(alphaMode);
      expect(material.attachedBlocks.some((block) => block instanceof LayerMultiplyBlock), doc.name).toBe(false);
    }
  });
});