import { afterEach, describe, expect, it } from "vitest";
import { Color4, InputBlock, MeshBuilder, NullEngine, Scene } from "@babylonjs/core";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@haptic/shader-graph";
import { instanceParameterAttribute, instanceParameterOf, prepareInstanceParameters } from "./instance-parameters";
import { compileMaterialPlan } from "./material-compiler";

const disposers: Array<() => void> = [];
afterEach(() => { while (disposers.length) disposers.pop()?.(); });

/** A Material whose base colour is the Color parameter Tint, and whose Roughness is the Float parameter Grit. */
function tinted(tintPerInstance: boolean, gritPerInstance = false) {
  const engine = new NullEngine();
  engine.getCaps().instancedArrays = true;
  const scene = new Scene(engine);
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  const doc = createDefaultMaterialDocument("tinted");
  const tint = doc.nodes.find((node) => node.id === "baseColor")!;
  tint.type = "param.color";
  tint.properties = { name: "Tint", value: [1, 0.5, 0.25, 1], perInstance: tintPerInstance };
  doc.edges.find((edge) => edge.sourceNodeId === "baseColor")!.sourcePinId = "rgb";
  doc.nodes.push({ id: "grit", type: "param.float", position: { x: 0, y: 100 }, properties: { name: "Grit", value: [0.3], perInstance: gritPerInstance } });
  doc.edges.push({ id: "e-grit", sourceNodeId: "grit", sourcePinId: "out", targetNodeId: "output", targetPinId: "roughness" });
  const lowered = lowerMaterialDocument(doc);
  if (!lowered.ok) throw new Error("did not lower");
  const compiled = compileMaterialPlan(lowered.plan, { scene, name: "tinted" });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  return { scene, compiled, material: compiled.material };
}

const linear = (r: number, g: number, b: number, a = 1) => new Color4(r, g, b, a).toLinearSpace();

describe("per-instance Material parameters", () => {
  it("reads a parameter marked Per Instance from an instanced attribute, the others from uniforms", () => {
    const { material } = tinted(true);
    const attributes = material.getInputBlocks().filter((block) => block.isAttribute).map((block) => block.name);
    expect(attributes).toContain(instanceParameterAttribute(0));
    expect(material.getInputBlocks().find((block) => block.name === instanceParameterAttribute(0))?.isUniform).toBe(false);
    expect(instanceParameterOf(material, "Tint")).toEqual({ name: "Tint", attribute: instanceParameterAttribute(0), kind: "color" });
    expect(instanceParameterOf(material, "Grit")).toBeUndefined();
    expect(tinted(false).material.getInputBlocks().some((block: InputBlock) => block.name.startsWith("instanceParameter_"))).toBe(false);
  });

  it("names attributes with letters only, as Babylon strips digits", () => {
    expect([0, 1, 25, 26, 27].map(instanceParameterAttribute)).toEqual(
      ["instanceParameter_a", "instanceParameter_b", "instanceParameter_z", "instanceParameter_aa", "instanceParameter_ab"]);
  });

  it("registers the attribute on a mesh the Material draws, holding its value in linear space, and on a source's instances", () => {
    const { scene, material, compiled } = tinted(true, true);
    const box = MeshBuilder.CreateBox("box", {}, scene);
    box.material = material;
    const copy = box.createInstance("copy");
    material.isReadyForSubMesh(box, box.subMeshes[0]!, true);
    const [tint, grit] = [instanceParameterOf(material, "Tint")!.attribute, instanceParameterOf(material, "Grit")!.attribute];
    expect((box.instancedBuffers[tint] as Color4).equalsWithEpsilon(linear(1, 0.5, 0.25))).toBe(true);
    expect([box.instancedBuffers[grit], copy.instancedBuffers[grit]]).toEqual([0.3, 0.3]);
    expect((copy.instancedBuffers[tint] as Color4).equalsWithEpsilon(linear(1, 0.5, 0.25))).toBe(true);
    const value = compiled.getParameter("Tint");
    expect(value?.kind === "color" && value.value.map((channel) => Math.round(channel * 1000) / 1000)).toEqual([1, 0.5, 0.25, 1]);
  });

  it("gives the Material's new value to every mesh holding its value, not to one carrying its own", () => {
    const { scene, material, compiled } = tinted(true);
    const box = MeshBuilder.CreateBox("box", {}, scene);
    box.material = material;
    const [same, own] = [box.createInstance("same"), box.createInstance("own")];
    prepareInstanceParameters(box, material);
    const tint = instanceParameterOf(material, "Tint")!.attribute;
    own.instancedBuffers[tint] = linear(0, 1, 0);
    expect(compiled.setParameter("Tint", { kind: "color", value: [0.2, 0.4, 0.6, 1] })).toBe(true);
    for (const holder of [box, same]) expect((holder.instancedBuffers[tint] as Color4).equalsWithEpsilon(linear(0.2, 0.4, 0.6))).toBe(true);
    expect((own.instancedBuffers[tint] as Color4).equalsWithEpsilon(linear(0, 1, 0))).toBe(true);
    expect(compiled.getParameter("Tint")).toEqual({ kind: "color", value: [0.2, 0.4, 0.6, 1] });
  });

  it("refuses a value of the wrong kind for a per-instance parameter", () => {
    const { compiled } = tinted(true);
    expect(compiled.setParameter("Tint", { kind: "float", value: 1 })).toBe(false);
  });
});
