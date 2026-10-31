import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HemisphericLight,
  type Mesh,
  NullEngine,
  Scene,
  StandardMaterial,
  Vector3,
  type NodeMaterial,
} from "@babylonjs/core";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@haptic/shader-graph";
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
