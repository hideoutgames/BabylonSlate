import { afterEach, describe, expect, it, vi } from "vitest";
import { ArcRotateCamera, Constants, DiscardBlock, FragmentOutputBlock, InputBlock, MeshBuilder, MultiplyBlock, NullEngine, PrecisionDate, Scene, Vector3, type NodeMaterialConnectionPoint } from "@babylonjs/core";
import { createDefaultMaterialDocument, lowerMaterialDocument, type MaterialDocument } from "@babylonslate/shader-graph";
import { compileMaterialPlan } from "./material-compiler";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { ImageSourceBlock } from "@babylonjs/core/Materials/Node/Blocks/Dual/imageSourceBlock";

const dispose: Array<() => void> = [];
afterEach(() => { while (dispose.length) dispose.pop()!(); vi.restoreAllMocks(); });

async function compile(doc: MaterialDocument, particlePreview = false) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  dispose.push(() => { scene.dispose(); engine.dispose(); });
  const plan = lowerMaterialDocument(doc);
  if (!plan.ok) throw new Error(JSON.stringify(plan.diagnostics));
  const result = compileMaterialPlan(plan.plan, { scene, name: "contract", particlePreview });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  dispose.push(result.dispose);
  expect(await result.ready).toEqual([]);
  return result;
}

function node(doc: MaterialDocument, id: string, type: string, properties = {}) {
  doc.nodes.push({ id, type, position: { x: 0, y: 0 }, properties });
}
function wire(doc: MaterialDocument, source: string, sourcePin: string, target: string, targetPin: string) {
  doc.edges.push({ id: `${source}-${sourcePin}-${target}-${targetPin}`, sourceNodeId: source, sourcePinId: sourcePin, targetNodeId: target, targetPinId: targetPin });
}

describe("material node contracts", () => {
  it("builds distinct legal texture samplers from editor-generated numeric node IDs", async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    dispose.push(() => { scene.dispose(); engine.dispose(); });
    const textures = [new Texture(null, scene), new Texture(null, scene)];
    for (const texture of textures) vi.spyOn(texture, "isReady").mockReturnValue(true);
    const doc = createDefaultMaterialDocument();
    doc.shadingModel = "unlit";
    doc.edges = [];
    for (const [index, id] of ["texture.sample-123", "texture.sample-456"].entries()) {
      node(doc, id, "texture.sample", { textureGuid: `image-${index}` });
      wire(doc, id, "rgb", "output", index === 0 ? "baseColor" : "emissive");
    }
    node(doc, "param.float-123_456", "param.float", { name: "Opacity", value: 0.5 });
    wire(doc, "param.float-123_456", "out", "output", "opacity");
    const lowered = lowerMaterialDocument(doc);
    if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
    const result = compileMaterialPlan(lowered.plan, {
      scene, name: "generated-ids", resolveTexture: (guid) => textures[Number(guid.slice(-1))]!,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    dispose.push(result.dispose);
    expect(await result.ready).toEqual([]);
    const sources = result.material.attachedBlocks.filter((block): block is ImageSourceBlock => block instanceof ImageSourceBlock);
    expect(sources).toHaveLength(2);
    expect(new Set(sources.map((block) => block.samplerName)).size).toBe(2);
    expect(new Set(sources.map((block) => block.texture))).toEqual(new Set(textures));
    for (const block of sources) {
      expect(block.samplerName).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
      expect(block.samplerName).not.toContain("__");
      expect(result.material.compiledShaders).toContain(`sampler2D ${block.samplerName}`);
    }
    const uniforms = result.material.compiledShaders.match(/\buniform\s+\w+\s+(\w+)/g) ?? [];
    expect(uniforms.length).toBeGreaterThan(0);
    expect(uniforms.every((uniform) => !uniform.includes("__"))).toBe(true);
    expect(result.setParameter("Opacity", { kind: "float", value: 0.75 })).toBe(true);
    expect(result.material.attachedBlocks.some((block) => block instanceof InputBlock && block.value === 0.75)).toBe(true);
  });

  it.each(["parameter", "inline", "forwarded"])("compiles and binds a %s texture sampler for custom UV sampling", async (source) => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    dispose.push(() => { scene.dispose(); engine.dispose(); });
    const texture = new Texture(null, scene);
    vi.spyOn(texture, "isReady").mockReturnValue(true);
    const doc = createDefaultMaterialDocument();
    node(doc, "custom", "custom.glsl", {
      customVersion: 2,
      inputs: [{ id: "image", name: "Albedo", type: "texture" }, { id: "uv", name: "UV", type: "vec2" }],
      outputs: [{ id: "out", name: "Result", type: "vec3" }],
      body: "return texture2D(Albedo, UV * 2.0).rgb;",
    });
    if (source !== "inline") node(doc, "image", "param.texture", { name: "Image", textureGuid: "image" });
    if (source !== "parameter") {
      node(doc, "sample", "texture.sample", source === "inline" ? { textureGuid: "image" } : {});
      if (source === "forwarded") wire(doc, "image", "out", "sample", "texture");
    }
    wire(doc, source === "parameter" ? "image" : "sample", source === "parameter" ? "out" : "textureOut", "custom", "image");
    wire(doc, "custom", "out", "output", "emissive");
    const lowered = lowerMaterialDocument(doc);
    if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
    const result = compileMaterialPlan(lowered.plan, { scene, name: "sampler", resolveTexture: () => texture });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    dispose.push(result.dispose);
    expect(await result.ready).toEqual([]);
    expect(result.material.compiledShaders).toContain("sampler2D Albedo");
    expect(result.material.compiledShaders).toContain("texture2D(Albedo, UV * 2.0)");
    const sampler = result.material.getBlockByName("custom")!.inputs[0]!.connectedPoint!.ownerBlock as ImageSourceBlock;
    expect(sampler.texture).toBe(texture);
    if (source !== "inline") {
      expect(result.setParameter("Image", { kind: "texture", textureAssetGuid: null })).toBe(true);
      expect(sampler.texture).not.toBe(texture);
      expect(sampler.texture?.getSize()).toMatchObject({ width: 1, height: 1 });
    }
  });
  it("advances Seconds-mode Time when previews render without fresh engine frame deltas", async () => {
    const doc = createDefaultMaterialDocument();
    node(doc, "time", "input.time", { timeMode: "seconds" });
    node(doc, "sine", "math.sin");
    wire(doc, "time", "time", "sine", "value");
    wire(doc, "sine", "out", "output", "roughness");
    const result = await compile(doc);
    const scene = result.material.getScene();
    const engine = scene.getEngine();
    vi.spyOn(engine, "getDeltaTime").mockReturnValue(0);
    const clock = vi.spyOn(PrecisionDate, "Now", "get");
    new ArcRotateCamera("camera", 0, Math.PI / 4, 5, Vector3.Zero(), scene);
    const mesh = MeshBuilder.CreateSphere("preview", {}, scene);
    mesh.material = result.material;
    // Read the numeric shader input, including the previous seconds conversion.
    function scalar(point: NodeMaterialConnectionPoint): number {
      const block = point.ownerBlock;
      if (block instanceof InputBlock) return block.value as number;
      if (block instanceof MultiplyBlock) return scalar(block.left.connectedPoint!) * scalar(block.right.connectedPoint!);
      throw new Error(`Unexpected Time producer: ${block.getClassName()}`);
    }
    const time = result.material.getBlockByName("sine")!.getInputByName("input")!.connectedPoint!;
    clock.mockReturnValue(engine.startTime + 250);
    scene.render();
    const before = scalar(time);
    clock.mockReturnValue(engine.startTime + 1250);
    scene.render();
    expect(scalar(time) - before).toBeCloseTo(1);
  });
  it.each(["a", "b"])("compiles animated normal displacement with Time on Multiply %s", async (timePin) => {
    const doc = createDefaultMaterialDocument();
    node(doc, "time", "input.time", { timeMode: "seconds" });
    node(doc, "sine", "math.sin");
    node(doc, "normal", "input.vertexNormalWS");
    node(doc, "multiply", "math.multiply");
    wire(doc, "time", "time", "sine", "value");
    wire(doc, "sine", "out", "multiply", timePin);
    wire(doc, "normal", "normal", "multiply", timePin === "a" ? "b" : "a");
    wire(doc, "multiply", "out", "output", "worldPositionOffset");
    wire(doc, "multiply", "out", "output", "emissive");
    const result = await compile(doc);
    expect(result.material.compiledShaders).toContain("sin(");
    const scene = result.material.getScene();
    new ArcRotateCamera("camera", 0, Math.PI / 4, 5, Vector3.Zero(), scene);
    const mesh = MeshBuilder.CreateSphere("preview", {}, scene);
    mesh.material = result.material;
    scene.render();
    scene.render();
  });
  it("compiles VertexNormalWS in vertex displacement and fragment color", async () => {
    const doc = createDefaultMaterialDocument();
    node(doc, "normal", "input.vertexNormalWS");
    wire(doc, "normal", "normal", "output", "worldPositionOffset");
    wire(doc, "normal", "normal", "output", "emissive");
    await compile(doc);
  });
  it.each(["input.vertexPosition", "input.vertexNormal"])("compiles local geometry %s", async (type) => {
    const doc = createDefaultMaterialDocument();
    node(doc, "geometry", type);
    wire(doc, "geometry", type.endsWith("Position") ? "position" : "normal", "output", "emissive");
    await compile(doc);
  });
  it("compiles particle preview as a mesh shader while preserving live Particle mode", async () => {
    const doc = createDefaultMaterialDocument("Particle", "particle");
    const preview = await compile(doc, true);
    const live = await compile(doc);
    expect(preview.material.mode).toBe(0);
    expect(live.material.mode).toBe(2);
    expect(preview.material.compiledShaders).not.toContain("particle_color");
  });
  it("compiles Camera Position for Post Processing", async () => {
    const doc = createDefaultMaterialDocument("PP", "postProcess");
    node(doc, "camera", "input.cameraPosition");
    node(doc, "split", "vector.split");
    wire(doc, "camera", "position", "split", "value");
    // Camera information can drive any scalar effect parameter.
    node(doc, "color", "vector.combine");
    wire(doc, "split", "x", "color", "x");
    doc.edges = doc.edges.filter((edge) => edge.targetNodeId !== "output");
    wire(doc, "color", "xyzw", "output", "color");
    await compile(doc);
  });
  it("compiles nonadjacent VectorMask channels in RGBA order", async () => {
    const doc = createDefaultMaterialDocument();
    node(doc, "value", "const.vec3", { value: [0.2, 0.5, 0.8] });
    node(doc, "mask", "vector.mask", { b: true });
    node(doc, "split-mask", "vector.split");
    wire(doc, "value", "out", "mask", "value");
    wire(doc, "mask", "out", "split-mask", "value");
    wire(doc, "split-mask", "y", "output", "roughness");
    const result = await compile(doc);
    const merge = result.material.getBlockByName("mask_merge");
    expect(merge?.getInputByName("x")?.connectedPoint?.name).toBe("x");
    expect(merge?.getInputByName("y")?.connectedPoint?.name).toBe("z");
  });
  it("allows a scalar Split X output without inventing vector components", async () => {
    const doc = createDefaultMaterialDocument();
    node(doc, "split", "vector.split", { "default:value": [0.7] });
    wire(doc, "split", "x", "output", "roughness");
    await compile(doc);
  });
  it("compiles a typed Custom GLSL return and an independently typed additional output", async () => {
    const doc = createDefaultMaterialDocument();
    node(doc, "custom", "custom.glsl", {
      customVersion: 2,
      inputs: [{ id: "uv", name: "UV", type: "vec2" }],
      outputs: [{ id: "out", name: "Result", type: "vec3" }, { id: "mask", name: "Mask", type: "float" }],
      body: "Mask = step(0.5, UV.x);\nreturn vec3(UV, Mask);",
    });
    wire(doc, "custom", "out", "output", "emissive");
    wire(doc, "custom", "mask", "output", "roughness");
    const result = await compile(doc);
    const source = result.material.compiledShaders;
    expect(source).toContain("Mask = step(0.5, UV.x)");
    expect(source).toContain("out float Mask");
    expect(source).toContain("return vec3(UV, Mask)");
  });
  it("keeps dynamic Clamp bounds in the shader and exposes them to runtime setters", async () => {
    const doc = createDefaultMaterialDocument();
    node(doc, "minimum", "param.float", { name: "Minimum", value: [0.3] });
    node(doc, "maximum", "param.float", { name: "Maximum", value: [0.7] });
    node(doc, "clamp", "math.clamp", { "default:value": [0.5] });
    wire(doc, "minimum", "out", "clamp", "min");
    wire(doc, "maximum", "out", "clamp", "max");
    wire(doc, "clamp", "out", "output", "roughness");
    const result = await compile(doc);
    for (const id of ["minimum", "maximum"]) {
      const input = result.material.getInputBlockByPredicate((block) => block.name === id);
      expect(input?.output.hasEndpoints).toBe(true);
    }
    expect(result.setParameter("Minimum", { kind: "float", value: 0.2 })).toBe(true);
  });

  it.each(["vector.refract", "logic.lessThan", "logic.equal"])("compiles ordinary Vector 3 inputs for %s", async (type) => {
    const doc = createDefaultMaterialDocument();
    node(doc, "a", "const.vec3", { value: [0, 0, -1] });
    node(doc, "b", "const.vec3", { value: [0, 0, 1] });
    node(doc, "operation", type);
    wire(doc, "a", "out", "operation", type === "vector.refract" ? "incident" : "a");
    wire(doc, "b", "out", "operation", type === "vector.refract" ? "normal" : "b");
    wire(doc, "operation", "out", "output", "emissive");
    await compile(doc);
  });

  it.each(["pbr", "unlit"] as const)("uses an authored clip mask and additive blend on %s surfaces", async (shadingModel) => {
    const doc = createDefaultMaterialDocument();
    doc.shadingModel = shadingModel;
    doc.blendMode = "masked";
    doc.alphaCutoff = 0.23;
    node(doc, "mask", "const.float", { value: [0.1] });
    wire(doc, "mask", "out", "output", "alphaClip");
    const result = await compile(doc);
    const discard = result.material.getBlockByPredicate((block) => block instanceof DiscardBlock) as DiscardBlock;
    expect(discard?.value.connectedPoint?.ownerBlock.name).toContain("mask");
    expect(result.material.getInputBlockByPredicate((block) => block.name.endsWith("_alphaCutoff"))?.value).toBe(0.23);
    const fragment = result.material.getBlockByPredicate((block) => block instanceof FragmentOutputBlock) as FragmentOutputBlock;
    expect(fragment.a.isConnected).toBe(true);
    doc.blendMode = "additive";
    expect((await compile(doc)).material.alphaMode).toBe(Constants.ALPHA_ADD);
  });
});
