import { afterEach, describe, expect, it } from "vitest";
import { Constants, DiscardBlock, FragmentOutputBlock, NullEngine, Scene } from "@babylonjs/core";
import { createDefaultMaterialDocument, lowerMaterialDocument, type MaterialDocument } from "@babylonslate/shader-graph";
import { compileMaterialPlan } from "./material-compiler";

const dispose: Array<() => void> = [];
afterEach(() => { while (dispose.length) dispose.pop()!(); });

async function compile(doc: MaterialDocument) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  dispose.push(() => { scene.dispose(); engine.dispose(); });
  const plan = lowerMaterialDocument(doc);
  if (!plan.ok) throw new Error(JSON.stringify(plan.diagnostics));
  const result = compileMaterialPlan(plan.plan, { scene, name: "contract" });
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
