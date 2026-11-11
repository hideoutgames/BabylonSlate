import { afterEach, describe, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { ConditionalBlock, ConditionalBlockConditions } from "@babylonjs/core/Materials/Node/Blocks/conditionalBlock";
import { ImageSourceBlock } from "@babylonjs/core/Materials/Node/Blocks/Dual/imageSourceBlock";
import { InputBlock } from "@babylonjs/core/Materials/Node/Blocks/Input/inputBlock";
import { NormalizeBlock } from "@babylonjs/core/Materials/Node/Blocks/normalizeBlock";
import { TriPlanarBlock } from "@babylonjs/core/Materials/Node/Blocks/triPlanarBlock";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Scene } from "@babylonjs/core/scene";
import { createDefaultMaterialDocument, lowerMaterialDocument, type MaterialDocument, type MaterialDomain } from "@haptic/shader-graph";
import { GameTimeInputBlock } from "./game-time-input-block";
import { compileMaterialPlan } from "./material-compiler";

const dispose: Array<() => void> = [];
afterEach(() => { while (dispose.length) dispose.pop()!(); vi.restoreAllMocks(); });

async function compile(doc: MaterialDocument, options: { floatingOrigin?: boolean; texture?: boolean } = {}) {
  const engine = new NullEngine();
  const scene = new Scene(engine, { useFloatingOrigin: options.floatingOrigin === true });
  dispose.push(() => { scene.dispose(); engine.dispose(); });
  const texture = options.texture ? new Texture(null, scene) : null;
  if (texture) vi.spyOn(texture, "isReady").mockReturnValue(true);
  const plan = lowerMaterialDocument(doc);
  if (!plan.ok) throw new Error(JSON.stringify(plan.diagnostics));
  const result = compileMaterialPlan(plan.plan, { scene, name: "cohesion", ...(texture ? { resolveTexture: () => texture } : {}) });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  dispose.push(result.dispose);
  expect(await result.ready).toEqual([]);
  return { ...result, texture };
}

function surface(domain: MaterialDomain = "surface") {
  return createDefaultMaterialDocument("Cohesion", domain);
}
function node(doc: MaterialDocument, id: string, type: string, properties = {}) {
  doc.nodes.push({ id, type, position: { x: 0, y: 0 }, properties });
}
function wire(doc: MaterialDocument, source: string, sourcePin: string, target: string, targetPin: string) {
  doc.edges.push({ id: `${source}-${sourcePin}-${target}-${targetPin}`, sourceNodeId: source, sourcePinId: sourcePin, targetNodeId: target, targetPinId: targetPin });
}
/** The fragment shader after the vertex shader in Babylon's dump. */
function fragment(source: string) {
  return source.slice(source.indexOf("Fragment shader"));
}

describe("Material logic nodes", () => {
  it.each([
    ["logic.lessOrEqual", ConditionalBlockConditions.LessOrEqual],
    ["logic.greaterOrEqual", ConditionalBlockConditions.GreaterOrEqual],
  ] as const)("compiles %s per component into 1 or 0", async (type, condition) => {
    const doc = surface();
    node(doc, "a", "const.vec3", { value: [0, 0.5, 1] });
    node(doc, "compare", type, { "default:b": [0.5] });
    wire(doc, "a", "out", "compare", "a");
    wire(doc, "compare", "out", "output", "emissive");
    const result = await compile(doc);
    for (const axis of ["x", "y", "z"]) {
      const block = result.material.getBlockByName(`compare_${axis}`) as ConditionalBlock;
      expect(block.condition).toBe(condition);
      expect((block.true.connectedPoint!.ownerBlock as InputBlock).value).toBe(1);
      expect((block.false.connectedPoint!.ownerBlock as InputBlock).value).toBe(0);
    }
  });

  it.each([["logic.and", "min("], ["logic.or", "max("]])("reads %s as the smaller or larger mask above 0.5", async (type, combine) => {
    const doc = surface();
    node(doc, "mask", type, { "default:a": [1], "default:b": [0] });
    wire(doc, "mask", "out", "output", "roughness");
    const result = await compile(doc);
    const test = result.material.getBlockByName("mask") as ConditionalBlock;
    expect(test.condition).toBe(ConditionalBlockConditions.GreaterThan);
    expect((test.b.connectedPoint!.ownerBlock as InputBlock).value).toBe(0.5);
    expect(fragment(result.material.compiledShaders)).toContain(combine);
  });

  it("turns a mask around with Not: 0 above 0.5 and 1 elsewhere", async () => {
    const doc = surface();
    node(doc, "not", "logic.not", { "default:value": [1] });
    wire(doc, "not", "out", "output", "roughness");
    const result = await compile(doc);
    const test = result.material.getBlockByName("not") as ConditionalBlock;
    expect((test.true.connectedPoint!.ownerBlock as InputBlock).value).toBe(0);
    expect((test.false.connectedPoint!.ownerBlock as InputBlock).value).toBe(1);
  });

  it("keeps one conditional for a Select whose Condition is one Float, and one per component for a vector Condition", async () => {
    const conditionals = async (conditionType: string) => {
      const doc = surface();
      node(doc, "condition", conditionType, { value: [1, 0, 1] });
      node(doc, "yes", "const.vec3", { value: [1, 0, 0] });
      node(doc, "select", "logic.select");
      wire(doc, "condition", "out", "select", "condition");
      wire(doc, "yes", "out", "select", "whenTrue");
      wire(doc, "select", "out", "output", "emissive");
      const result = await compile(doc);
      return result.material.attachedBlocks.filter((block) => block instanceof ConditionalBlock).length;
    };
    expect(await conditionals("const.float")).toBe(1);
    expect(await conditionals("const.vec3")).toBe(3);
  });
});

describe("Material UV nodes", () => {
  it("scrolls a Panner by the game's Time until Time is wired", async () => {
    const doc = surface();
    node(doc, "panner", "texture.panner");
    node(doc, "sample", "texture.sample", { textureGuid: "image" });
    wire(doc, "panner", "out", "sample", "uv");
    wire(doc, "sample", "rgb", "output", "emissive");
    const unwired = await compile(doc, { texture: true });
    expect(unwired.material.attachedBlocks.some((block) => block instanceof GameTimeInputBlock)).toBe(true);
    node(doc, "clock", "const.float", { value: [2] });
    wire(doc, "clock", "out", "panner", "time");
    const wired = await compile(doc, { texture: true });
    expect(wired.material.attachedBlocks.some((block) => block instanceof GameTimeInputBlock)).toBe(false);
  });

  it.each(["texture.rotator", "texture.flipbook"])("compiles %s on the mesh UV into a Texture Sample", async (type) => {
    const doc = surface();
    node(doc, "uv", type);
    node(doc, "sample", "texture.sample", { textureGuid: "image" });
    wire(doc, "uv", "out", "sample", "uv");
    wire(doc, "sample", "rgb", "output", "emissive");
    const result = await compile(doc, { texture: true });
    // The node's own inputs reach the fragment stage as they are, not as varyings interpolated across the triangle.
    expect(fragment(result.material.compiledShaders)).not.toMatch(/\bv_output\d/);
  });

  it.each(["surface", "postProcess", "particle"] as const)("gives Screen UV in a %s material", async (domain) => {
    const doc = surface(domain);
    if (domain === "surface") {
      node(doc, "screen", "input.screenUv");
      node(doc, "color", "vector.combine");
      node(doc, "split", "vector.split");
      wire(doc, "screen", "uv", "split", "value");
      wire(doc, "split", "x", "color", "x");
      wire(doc, "split", "y", "color", "y");
      wire(doc, "color", "xyz", "output", "emissive");
    } else if (domain === "particle") {
      doc.edges = [];
      node(doc, "screen", "input.screenUv");
      wire(doc, "screen", "uv", "output", "color");
    }
    const result = await compile(doc);
    if (domain === "surface") expect(fragment(result.material.compiledShaders)).toContain("gl_FragCoord");
  });
});

describe("Material composite nodes", () => {
  it.each([
    ["math.mod", { "default:a": [5], "default:b": [3] }, "roughness"],
    ["vector.reflect", { "default:incident": [0, 0, -1], "default:normal": [0, 0, 1] }, "emissive"],
  ] as const)("reads the constants wired into %s in the fragment stage, without a varying for each", async (type, properties, pin) => {
    const doc = surface();
    node(doc, "composite", type, properties);
    wire(doc, "composite", "out", "output", pin);
    const result = await compile(doc);
    expect(fragment(result.material.compiledShaders)).not.toMatch(/\bv_output\d/);
  });
});

describe("Material inputs", () => {
  it.each([false, true])("places Object Position at the mesh origin in absolute scene coordinates (floating origin %s)", async (floatingOrigin) => {
    const doc = surface();
    node(doc, "origin", "input.objectPosition");
    wire(doc, "origin", "position", "output", "emissive");
    const result = await compile(doc, { floatingOrigin });
    expect(result.material.getBlockByName("origin")?.getClassName()).toBe("TransformBlock");
    const origin = result.material.getBlockByName("slateFloatingOrigin") as InputBlock;
    expect(origin.output.endpoints.map((endpoint) => endpoint.ownerBlock.name)).toEqual(["origin_absolute"]);
  });

  it("gives World Normal at unit length", async () => {
    const doc = surface();
    node(doc, "facing", "input.worldNormal");
    wire(doc, "facing", "normal", "output", "emissive");
    const result = await compile(doc);
    expect(result.material.getBlockByName("facing")).toBeInstanceOf(NormalizeBlock);
  });

  it.each([["input.vertexColor", "surface"], ["input.particleColor", "particle"]] as const)("splits %s into RGB and A", async (type, domain) => {
    const doc = surface(domain);
    doc.edges = [];
    doc.nodes = doc.nodes.filter((entry) => entry.type.startsWith("output."));
    node(doc, "color", type);
    node(doc, "faded", "math.multiply");
    wire(doc, "color", "rgb", "faded", "a");
    wire(doc, "color", "a", "faded", "b");
    wire(doc, "faded", "out", "output", domain === "surface" ? "emissive" : "color");
    await compile(doc);
  });

  it("gives a Color Parameter its alpha as A", async () => {
    const doc = surface();
    node(doc, "tint", "param.color", { name: "Tint", value: [1, 0.5, 0.25, 0.5] });
    wire(doc, "tint", "a", "output", "roughness");
    const result = await compile(doc);
    expect(result.setParameter("Tint", { kind: "color", value: [0, 0, 0, 1] })).toBe(true);
  });
});

describe("Material vector, color and shading nodes", () => {
  it("compiles Swizzle components in output order", async () => {
    const doc = surface();
    node(doc, "value", "const.vec3", { value: [0.2, 0.5, 0.8] });
    node(doc, "swizzle", "vector.swizzle", { components: "zxx" });
    wire(doc, "value", "out", "swizzle", "value");
    wire(doc, "swizzle", "out", "output", "emissive");
    const result = await compile(doc);
    const merge = result.material.getBlockByName("swizzle_merge");
    expect(["x", "y", "z"].map((axis) => merge?.getInputByName(axis)?.connectedPoint?.name)).toEqual(["z", "x", "x"]);
  });

  it.each(["color.contrast", "color.blendScreen", "color.blendOverlay", "color.posterize", "color.rgbToHsl", "color.hslToRgb", "shading.normalBlend"])(
    "compiles %s on a Vector3", async (type) => {
      const doc = surface();
      node(doc, "value", "const.vec3", { value: [0.2, 0.5, 0.8] });
      node(doc, "operation", type);
      const pin = { "color.contrast": "color", "color.blendScreen": "base", "color.blendOverlay": "base", "color.posterize": "value", "color.rgbToHsl": "color", "color.hslToRgb": "hsl", "shading.normalBlend": "a" }[type]!;
      wire(doc, "value", "out", "operation", pin);
      wire(doc, "operation", "out", "output", "emissive");
      await compile(doc);
    });

  it("weighs Luminance as Desaturate does", async () => {
    const doc = surface();
    node(doc, "luminance", "color.luminance", { "default:color": [1, 0.5, 0.25] });
    wire(doc, "luminance", "out", "output", "roughness");
    const result = await compile(doc);
    const weights = result.material.getBlockByName("luminance")!.inputs[1]!.connectedPoint!.ownerBlock as InputBlock;
    expect(weights.value.asArray()).toEqual([0.3, 0.59, 0.11]);
  });

  it("samples Triplanar from a wired Texture by the world position and normal", async () => {
    const doc = surface();
    node(doc, "image", "param.texture", { name: "Image", textureGuid: "image" });
    node(doc, "triplanar", "texture.triplanar");
    wire(doc, "image", "out", "triplanar", "texture");
    wire(doc, "triplanar", "rgb", "output", "emissive");
    const result = await compile(doc, { texture: true });
    const block = result.material.getBlockByName("triplanar") as TriPlanarBlock;
    expect(block).toBeInstanceOf(TriPlanarBlock);
    expect(block.source.connectedPoint!.ownerBlock).toBeInstanceOf(ImageSourceBlock);
    expect(block.texture).toBe(result.texture);
    expect(block.convertToLinearSpace).toBe(true);
  });

  it("needs a Texture on Triplanar", () => {
    const doc = surface();
    node(doc, "triplanar", "texture.triplanar");
    wire(doc, "triplanar", "rgb", "output", "emissive");
    const lowered = lowerMaterialDocument(doc);
    expect(lowered.ok).toBe(false);
    if (!lowered.ok) expect(lowered.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "material.missingInput", nodeId: "triplanar" })]));
  });
});
