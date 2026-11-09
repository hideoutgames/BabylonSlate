import { afterEach, describe, expect, it, vi } from "vitest";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import {
  componentCount,
  createDefaultMaterialDocument,
  lowerMaterialDocument,
  type MaterialDocument,
  type MaterialOperand,
} from "@haptic/shader-graph";
import {
  ENGINE_DEFAULT_CHECKER_GREYS,
  createEngineDefaultMaterial,
  engineDefaultMaterialDocument,
  installEngineDefaultMaterial,
  isEngineDefaultMaterial,
} from "./default-material";
import { HapticLightingBlock } from "./haptic-lighting-block";
import { createPrimitiveMesh } from "./scene-loader";
import { applySceneEnvironment } from "./scene-illumination";
import { createDefaultScene } from "@haptic/core";
import { isUnlitMaterial } from "./unlit-material";

const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
  [];

afterEach(() => {
  while (handles.length > 0) {
    const handle = handles.pop();
    handle?.scene.dispose();
    handle?.engine.dispose();
  }
});

/**
 * Evaluates a lowered surface graph's Base Color on the CPU at one world-space point, with GLSL semantics for each
 * node the engine default uses. A conversion splats a Float or keeps a vector's leading channels.
 */
function evaluateBaseColor(document: MaterialDocument, position: number[], normal: number[]): number[] {
  const lowered = lowerMaterialDocument(document);
  if (!lowered.ok) throw new Error(lowered.diagnostics.map((row) => row.message).join("; "));
  const results = new Map<string, Record<string, number[]>>();
  const read = (operand: MaterialOperand): number[] => {
    if (operand.kind === "constant") return operand.value;
    let value = results.get(operand.operationId)![operand.pinId]!;
    for (const { from, to } of operand.conversions ?? []) {
      const source = value;
      value = Array.from({ length: componentCount(to) }, (_, index) =>
        from === "float" ? source[0]! : (source[index] ?? 1));
    }
    return value;
  };
  const zip = (values: number[][], combine: (...components: number[]) => number) =>
    Array.from({ length: Math.max(...values.map((value) => value.length)) }, (_, index) =>
      combine(...values.map((value) => value[value.length === 1 ? 0 : index]!)));
  for (const operation of lowered.plan.operations) {
    const pin = (id: string) => read(operation.inputs[id]!);
    const out = (value: number[]) => ({ out: value });
    const outputs = ((): Record<string, number[]> => {
      switch (operation.nodeType) {
        case "input.worldPosition": return { position };
        case "input.worldNormal": return { normal };
        case "const.vec3":
        case "const.color":
        case "param.float": return out(operation.properties.value as number[]);
        case "math.add": return out(zip([pin("a"), pin("b")], (a, b) => a + b));
        case "math.subtract": return out(zip([pin("a"), pin("b")], (a, b) => a - b));
        case "math.multiply": return out(zip([pin("a"), pin("b")], (a, b) => a * b));
        case "math.max": return out(zip([pin("a"), pin("b")], Math.max));
        case "math.step": return out(zip([pin("edge"), pin("value")], (edge, value) => (value < edge ? 0 : 1)));
        case "math.mix": return out(zip([pin("a"), pin("b"), pin("alpha")], (a, b, t) => a + (b - a) * t));
        case "math.abs": return out(pin("value").map(Math.abs));
        case "math.floor": return out(pin("value").map(Math.floor));
        case "math.fract": return out(pin("value").map((value) => value - Math.floor(value)));
        case "vector.split": {
          const [x, y, z, w] = pin("value");
          return { x: [x!], y: [y!], z: [z!], w: [w!] };
        }
        case "vector.combine": {
          const [x, y, z, w] = ["x", "y", "z", "w"].map((id) => pin(id)[0]!);
          return { xy: [x!, y!], xyz: [x!, y!, z!], xyzw: [x!, y!, z!, w!] };
        }
        case "vector.dot": return out([zip([pin("a"), pin("b")], (a, b) => a * b).reduce((sum, term) => sum + term, 0)]);
        default: throw new Error(`No CPU evaluation for ${operation.nodeType}`);
      }
    })();
    results.set(operation.id, outputs);
  }
  return read(lowered.plan.outputs.baseColor!);
}

function rawScene(): Scene {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  handles.push({ engine, scene });
  return scene;
}

describe("engine default material", () => {
  it("is a lit checker Material whose light grey is a new surface Material's Base Color", async () => {
    const scene = rawScene();
    new HemisphericLight("fill", Vector3.Up(), scene);
    const material = createEngineDefaultMaterial(scene);
    // Its colour comes from the graph, not the Material Output's constants.
    const lowered = lowerMaterialDocument(engineDefaultMaterialDocument());
    expect(lowered.ok && [lowered.plan.outputs.baseColor?.kind, lowered.plan.outputs.emissive?.kind]).toEqual(["operation", "operation"]);
    const newMaterialBaseColor = createDefaultMaterialDocument().nodes.find((node) => node.type === "const.color")!.properties.value;
    expect(newMaterialBaseColor).toEqual([ENGINE_DEFAULT_CHECKER_GREYS[0], ENGINE_DEFAULT_CHECKER_GREYS[0], ENGINE_DEFAULT_CHECKER_GREYS[0]]);
    expect(ENGINE_DEFAULT_CHECKER_GREYS.map((grey) => Math.round(grey * 255))).toEqual([204, 166]);
    const box = createPrimitiveMesh(scene, "box", "box");
    scene.defaultMaterial = material;
    // Its shaders load asynchronously.
    await vi.waitFor(() => expect(material.isReadyForSubMesh(box, box.subMeshes[0]!)).toBe(true));
    // Lit by the light block: it reads the lights from their uniform buffer and compiles no light defines.
    expect(material.attachedBlocks.some((block) => block instanceof HapticLightingBlock)).toBe(true);
    expect(box.subMeshes[0]!.effect?.defines).not.toMatch(/#define LIGHT\d/);
    expect(material.compiledShaders).toContain("uniform HapticLights");
  });

  it("draws square world-aligned quarter-unit cells, so scaling a mesh never stretches them", () => {
    const [light, dark] = ENGINE_DEFAULT_CHECKER_GREYS;
    const document = engineDefaultMaterialDocument();
    const greys = (normal: number[], points: number[][]) =>
      points.map((point) => evaluateBaseColor(document, point, normal)[0]);
    const up = [0, 1, 0];
    // A ground plane: the cells run along X and Z, and its height (on a cell boundary, or just under it) never matters.
    expect(greys(up, [[0.1, 0, 0.1], [0.3, 0, 0.1], [0.3, 0, 0.3], [-0.1, 0, 0.1]])).toEqual([light, dark, light, dark]);
    expect(greys(up, [[0.1, 0, 0.1], [0.1, -0.0001, 0.1], [0.1, 0.3, 0.1]])).toEqual([light, light, light]);
    // The same cell width at the far end of a box stretched four times along X.
    expect(greys(up, [[2.6, 0.75, 0.1], [2.8, 0.75, 0.1]])).toEqual([light, dark]);
    // Side and front faces lying on a cell boundary use their own plane.
    expect(greys([-1, 0, 0], [[-0.75, 0.1, 0.1], [-0.75, 0.1, 0.35], [-0.75, 0.6, 0.1]])).toEqual([light, dark, light]);
    expect(greys([0, 0, -1], [[0.1, 0.1, -0.75], [0.35, 0.1, -0.75]])).toEqual([light, dark]);
    // A 45° slope still takes exactly one plane: Y wins the tie, so the cells run along X and Z.
    expect(greys([0, Math.SQRT1_2, Math.SQRT1_2], [[0.1, 0.9, 0.1], [0.1, 0.6, 0.35]])).toEqual([light, dark]);
  });

  it("gives a mesh whose scaling turns non-uniform after its first readiness check the program of one that starts so", async () => {
    const scene = rawScene();
    new HemisphericLight("fill", Vector3.Up(), scene);
    const material = createEngineDefaultMaterial(scene);
    scene.defaultMaterial = material;
    const [early, late] = ["early", "late"].map((name) => createPrimitiveMesh(scene, name, "box"));
    for (const mesh of [early!, late!]) mesh.scaling.set(12, 0.2, 12);
    const ready = (...meshes: Mesh[]) => vi.waitFor(() => {
      for (const mesh of meshes) expect(material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)).toBe(true);
    });
    // A load's warm-up and readiness probes can check a mesh before its first world matrix.
    await ready(early!);
    scene.incrementRenderId();
    for (const mesh of [early!, late!]) mesh.computeWorldMatrix(true);
    await ready(early!, late!);
    expect(early!.subMeshes[0]!.effect!.defines).toMatch(/NONUNIFORMSCALING/);
    expect(early!.subMeshes[0]!.effect).toBe(late!.subMeshes[0]!.effect);
  });

  it("emits its checker in a 2D scene, which has no lights, and not in 3D", () => {
    const scene = rawScene();
    const material = installEngineDefaultMaterial(scene) as NodeMaterial;
    material.freeze();
    const emission = () => material.getInputBlocks().find((block) => block.name === "emission")?.value;
    applySceneEnvironment(scene, createDefaultScene("2d"));
    expect(emission()).toBe(1);
    expect(material.isFrozen).toBe(true);
    applySceneEnvironment(scene, createDefaultScene("3d"));
    expect(emission()).toBe(0);
  });

  it("installs as scene.defaultMaterial and reuses the same instance", () => {
    const scene = rawScene();
    const first = installEngineDefaultMaterial(scene);
    const second = installEngineDefaultMaterial(scene);

    expect(scene.defaultMaterial).toBe(first);
    expect(second).toBe(first);
    expect(isEngineDefaultMaterial(scene.defaultMaterial)).toBe(true);
  });

  it("replaces Babylon's Standard default material", () => {
    const scene = rawScene();
    const previous = scene.defaultMaterial;
    expect(previous).toBeInstanceOf(StandardMaterial);
    expect(previous.name).toBe("default material");

    const installed = installEngineDefaultMaterial(scene);
    expect(scene.defaultMaterial).toBe(installed);
    expect(installed).not.toBe(previous);
    expect(isEngineDefaultMaterial(previous)).toBe(false);
  });

  it("leaves a primitive mesh with no authored material on the engine default", () => {
    const scene = rawScene();
    installEngineDefaultMaterial(scene);
    const mesh = createPrimitiveMesh(scene, "box", "box");

    expect(mesh.material).toBeNull();
    expect(isEngineDefaultMaterial(scene.defaultMaterial)).toBe(true);
  });

  it("does not replace a pivot marker's explicit material", () => {
    const scene = rawScene();
    installEngineDefaultMaterial(scene);
    const pivot = createPrimitiveMesh(scene, "origin", "pivot");

    expect(pivot.material).not.toBeNull();
    expect(isEngineDefaultMaterial(pivot.material)).toBe(false);
    expect(isUnlitMaterial(pivot.material)).toBe(true);
  });

  it("does not replace an already assigned sprite-style material", () => {
    const scene = rawScene();
    installEngineDefaultMaterial(scene);
    const mesh = createPrimitiveMesh(scene, "sprite", "box");
    const spriteMat = new StandardMaterial("albedo:tex", scene);
    spriteMat.disableLighting = true;
    mesh.material = spriteMat;
    installEngineDefaultMaterial(scene);

    expect(mesh.material).toBe(spriteMat);
    expect(isEngineDefaultMaterial(mesh.material)).toBe(false);
  });
});
