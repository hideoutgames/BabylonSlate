import {
  MaterialDefines,
  MaterialHelper,
  MeshBuilder,
  NullEngine,
  PBRMaterial,
  PointLight,
  RawTexture,
  Scene,
  StandardMaterial,
  Vector3,
  type Material,
} from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultMaterialDocument,
  lowerMaterialDocument,
} from "@babylonslate/shader-graph";
import { compileMaterialPlan } from "./material-compiler";
import { setupDefaultViewport } from "./viewport";
import { ViewportShadingOverlay } from "./viewport-shading-mode";
import { beginSlotModelAnimLoad, createModelActorRoot } from "./glb-anim";
import { encodeUvHierarchyGlb } from "./model-mesh";
import { createSnapshotSceneBinding } from "./snapshot-apply";
import { visualMeshes } from "./visual-meshes";

const engines: NullEngine[] = [];

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

function host(viewport = true) {
  const engine = new NullEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  if (viewport) setupDefaultViewport(scene);
  return scene;
}

function lights(scene: Scene, count: number) {
  return Array.from(
    { length: count },
    (_, index) =>
      new PointLight(`lamp-${index}`, new Vector3(index, 3, 0), scene),
  );
}

function beginFrame(scene: Scene) {
  scene.incrementRenderId();
  scene.onBeforeRenderObservable.notifyObservers(scene);
}

function shaderLights(
  scene: Scene,
  material: Material & { maxSimultaneousLights: number },
) {
  const mesh = MeshBuilder.CreateBox("receiver", {}, scene);
  mesh.material = material;
  // The actual Babylon shader light selection is the observable contract: an
  // existing scene light is useless if the material drops its LIGHT define.
  beginFrame(scene);
  const defines = new MaterialDefines() as MaterialDefines &
    Record<string, unknown>;
  MaterialHelper.PrepareDefinesForLights(
    scene,
    mesh,
    defines,
    true,
    material.maxSimultaneousLights,
  );
  mesh.dispose();
  return defines;
}

describe("scene material lighting", () => {
  it("includes the fifth and sixth scene lights in the default material shader", () => {
    const scene = host();
    lights(scene, 6);
    const defines = shaderLights(scene, scene.defaultMaterial as PBRMaterial);
    expect(defines.LIGHT4).toBe(true);
    expect(defines.LIGHT5).toBe(true);
  });

  it("uses all scene lights in compiled surface graphs and late imported materials", () => {
    const scene = host(false);
    lights(scene, 6);
    const lowered = lowerMaterialDocument(createDefaultMaterialDocument());
    if (!lowered.ok) throw new Error("Fixture material did not lower");
    const compiled = compileMaterialPlan(lowered.plan, {
      scene,
      name: "surface",
    });
    if (!compiled.ok) throw new Error("Fixture material did not compile");
    const materials = [
      compiled.material,
      new PBRMaterial("imported", scene),
      new StandardMaterial("imported-standard", scene),
    ];
    for (const material of materials) {
      expect(shaderLights(scene, material).LIGHT5).toBe(true);
    }
  });

  it("updates asynchronous GLB material clones before they render", async () => {
    const scene = host();
    lights(scene, 6);
    beginFrame(scene);
    const root = createModelActorRoot(scene, "model");
    await beginSlotModelAnimLoad(
      scene,
      createSnapshotSceneBinding(),
      1,
      "model",
      encodeUvHierarchyGlb({ separateMaterials: true }),
      root,
    );
    const parts = visualMeshes(root);
    expect(parts.length).toBe(2);
    for (const part of parts) {
      expect(part.material).toBeInstanceOf(PBRMaterial);
      expect(shaderLights(scene, part.material as PBRMaterial).LIGHT5).toBe(
        true,
      );
    }
  });

  it("expands a frozen NodeMaterial shader when lights arrive after its graph was built", async () => {
    const scene = host();
    // NullEngine cannot upload the BRDF lookup. Mock that texture readiness
    // boundary while retaining the real PBR block and generated shader.
    scene.environmentBRDFTexture = RawTexture.CreateRGBATexture(
      new Uint8Array([255, 255, 255, 255]),
      1,
      1,
      scene,
    );
    vi.spyOn(scene.environmentBRDFTexture, "isReady").mockReturnValue(true);
    lights(scene, 3);
    const lowered = lowerMaterialDocument(createDefaultMaterialDocument());
    if (!lowered.ok) throw new Error("Fixture material did not lower");
    const compiled = compileMaterialPlan(lowered.plan, {
      scene,
      name: "surface",
    });
    if (!compiled.ok) throw new Error("Fixture material did not compile");
    const material = compiled.material;
    material.allowShaderHotSwapping = false;
    const mesh = MeshBuilder.CreateBox("receiver", {}, scene);
    mesh.material = material;
    material.freeze();
    await vi.waitFor(() =>
      expect(material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)).toBe(true),
    );
    expect(material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)).toBe(true);
    expect(mesh.subMeshes[0]!.effect?.defines).not.toContain("#define LIGHT5");

    const added = lights(scene, 3);
    beginFrame(scene);
    await vi.waitFor(() =>
      expect(material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)).toBe(true),
    );
    expect(material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)).toBe(true);
    expect(mesh.subMeshes[0]!.effect?.defines).toContain("#define LIGHT5");
    expect(mesh.subMeshes[0]!.effect?.fragmentSourceCode).toContain(
      "vLightData5",
    );

    added[2]!.dispose();
    beginFrame(scene);
    await vi.waitFor(() =>
      expect(material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)).toBe(true),
    );
    expect(material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)).toBe(true);
    expect(mesh.subMeshes[0]!.effect?.defines).not.toContain("#define LIGHT5");
    expect(material.isFrozen).toBe(true);
  });

  it("refreshes frozen shaders when scene lighting changes", async () => {
    const scene = host();
    const lamps = lights(scene, 6);
    const material = new StandardMaterial("receiver", scene);
    const mesh = MeshBuilder.CreateBox("receiver", {}, scene);
    mesh.material = material;
    beginFrame(scene);
    material.freeze();
    await material.forceCompilationAsync(mesh);
    expect(material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)).toBe(true);
    expect(mesh.subMeshes[0]!.materialDefines?.toString()).toContain(
      "#define LIGHT5",
    );
    lamps[5]!.setEnabled(false);
    beginFrame(scene);
    await material.forceCompilationAsync(mesh);
    material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!);
    expect(mesh.subMeshes[0]!.materialDefines?.toString()).not.toContain(
      "#define LIGHT5",
    );
    lamps[5]!.setEnabled(true);
    beginFrame(scene);
    await material.forceCompilationAsync(mesh);
    material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!);
    expect(mesh.subMeshes[0]!.materialDefines?.toString()).toContain(
      "#define LIGHT5",
    );
    lamps[5]!.dispose();
    beginFrame(scene);
    await material.forceCompilationAsync(mesh);
    material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!);
    expect(mesh.subMeshes[0]!.materialDefines?.toString()).not.toContain(
      "#define LIGHT5",
    );
    scene.blockMaterialDirtyMechanism = true;
    scene.lightsEnabled = false;
    beginFrame(scene);
    await material.forceCompilationAsync(mesh);
    material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!);
    expect(mesh.subMeshes[0]!.materialDefines?.toString()).not.toContain(
      "#define LIGHT0",
    );
    scene.lightsEnabled = true;
    beginFrame(scene);
    await material.forceCompilationAsync(mesh);
    material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!);
    expect(mesh.subMeshes[0]!.materialDefines?.toString()).toContain(
      "#define LIGHT4",
    );
    expect(material.isFrozen).toBe(true);
    expect(scene.blockMaterialDirtyMechanism).toBe(true);
  });

  it("keeps unlit materials unchanged", () => {
    const scene = host();
    lights(scene, 6);
    const material = new StandardMaterial("overlay", scene);
    material.disableLighting = true;
    const pbr = new PBRMaterial("skybox", scene);
    pbr.unlit = true;
    beginFrame(scene);
    expect(material.maxSimultaneousLights).toBe(4);
    expect(pbr.maxSimultaneousLights).toBe(4);
    expect(material.disableLighting).toBe(true);
    expect(pbr.unlit).toBe(true);
  });

  it("restores all lights after adding them while the viewport is unlit", () => {
    const scene = host();
    const mesh = MeshBuilder.CreateBox("receiver", {}, scene);
    mesh.material = scene.defaultMaterial;
    const overlay = new ViewportShadingOverlay(scene);
    overlay.setMode("unlit");
    lights(scene, 6);
    beginFrame(scene);
    overlay.setMode("pbr");
    expect(
      shaderLights(scene, scene.defaultMaterial as PBRMaterial).LIGHT5,
    ).toBe(true);
  });
});
