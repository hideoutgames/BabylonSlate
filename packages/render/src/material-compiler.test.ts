import { afterEach, describe, expect, it } from "vitest";
import { NullEngine, Scene } from "@babylonjs/core";
import {
  createDefaultMaterialDocument,
  createDefaultMaterialFunctionDocument,
  lowerMaterialDocument,
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
  doc.edges = doc.edges.filter((edge) => edge.id !== "e-rgb-output");
  doc.edges.push(
    {
      id: "e-rgb-mul",
      sourceNodeId: "rgb",
      sourcePinId: "xyz",
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
    expect(classNames).toContain("VectorMergerBlock");
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
    doc.edges = doc.edges.filter((edge) => edge.id !== "e-rgb-output");
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
    const result = compileMaterialPlan(planFor(doc), {
      scene,
      name: "test",
      resolveTexture: (guid) => {
        requested.push(guid);
        return null;
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
    doc.edges = doc.edges.filter((edge) => edge.id !== "e-rgb-output");
    doc.edges.push(
      {
        id: "e-rgb-call",
        sourceNodeId: "rgb",
        sourcePinId: "xyz",
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
});
