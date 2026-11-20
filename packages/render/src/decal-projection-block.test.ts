import { afterEach, describe, expect, it } from "vitest";
import { Constants } from "@babylonjs/core/Engines/constants";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Material } from "@babylonjs/core/Materials/material";
import { Scene } from "@babylonjs/core/scene";
import { createDefaultMaterialDocument, lowerMaterialDocument, type MaterialDocument } from "@haptic/shader-graph";
import { DecalProjectionBlock, decalProjectionFragmentSource } from "./decal-projection-block";
import { HapticLightingBlock } from "./haptic-lighting-block";
import { compileMaterialPlan } from "./material-compiler";
import { MultiplyBlendFactorBlock } from "./multiply-blend-block";
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

describe("Multiply surface", () => {
  it("multiplies the scene by its factor in the world, and draws as Translucent on a Scene Layer", async () => {
    const doc = { ...createDefaultMaterialDocument("Stain"), shadingModel: "unlit" as const, blendMode: "multiply" as const };
    const lowered = lowerMaterialDocument(doc);
    if (!lowered.ok) throw new Error("did not lower");
    const host = scene();
    const world = compileMaterialPlan(lowered.plan, { scene: host, name: "world" });
    const overlay = compileMaterialPlan(lowered.plan, { scene: host, name: "overlay", overlay: true });
    if (!world.ok || !overlay.ok) throw new Error("did not compile");
    expect(await world.ready).toEqual([]);
    expect(await overlay.ready).toEqual([]);
    expect(world.material.alphaMode).toBe(Constants.ALPHA_MULTIPLY);
    expect(world.material.transparencyMode).toBe(Material.MATERIAL_ALPHABLEND);
    expect(world.material.attachedBlocks.some((block) => block instanceof MultiplyBlendFactorBlock)).toBe(true);
    expect(overlay.material.alphaMode).toBe(Constants.ALPHA_COMBINE);
    expect(overlay.material.attachedBlocks.some((block) => block instanceof MultiplyBlendFactorBlock)).toBe(false);
    world.dispose();
    overlay.dispose();
  });
});
