import {
  isForwardLightExcluded,
  setAuthoredLightEnabled,
  syncDirectionalLightPolicy,
  syncForwardLightPolicy,
} from "./light-policy";
import { forwardLightBudget } from "./forward-light-budget";
import { sceneLightingLimits, syncSceneLighting } from "./scene-lighting";
import { CelMaterial } from "./cel-material";
import { updateSceneRenderingSettings } from "./render-settings";
import { createRenderDiagnostics } from "./render-diagnostics";
import {
  DirectionalLight,
  MaterialDefines,
  MaterialHelper,
  MeshBuilder,
  NullEngine,
  NullEngineOptions,
  PBRMaterial,
  PointLight,
  RawTexture,
  Scene,
  SpotLight,
  StandardMaterial,
  TransformNode,
  UniversalCamera,
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
import { sceneShadowController } from "./shadow-controller";
import { ViewportShadingOverlay } from "./viewport-shading-mode";
import { beginSlotModelAnimLoad, createModelActorRoot } from "./glb-anim";
import { encodeUvHierarchyGlb } from "./model-mesh";
import { createSnapshotSceneBinding } from "./snapshot-apply";
import { visualMeshes } from "./visual-meshes";

const engines: NullEngine[] = [];

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

function host(viewport = true, uniformBuffers = true) {
  const options = new NullEngineOptions();
  // Babylon's headless WebGL2/multiview option supplies its real CPU-side UBO
  // boundary. Default NullEngine models the non-UBO four-light fallback.
  options.enableMultiview = uniformBuffers;
  const engine = new NullEngine(options);
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
  it("retains a bounded four-light fallback when uniform buffers are unavailable", () => {
    const scene = host(false, false);
    const lamps = lights(scene, 6);
    const material = new StandardMaterial("non-ubo", scene);
    syncSceneLighting(scene);
    expect(forwardLightBudget(scene.getEngine())).toMatchObject({
      slots: 4,
      source: "non-ubo",
    });
    const defines = shaderLights(scene, material);
    expect(defines.LIGHT3).toBe(true);
    expect(defines.LIGHT4).not.toBe(true);
    expect(material.maxSimultaneousLights).toBe(4);
    expect(lamps.filter(isForwardLightExcluded)).toHaveLength(2);
  });

  it.each(["pbr", "cel"] as const)(
    "bounds native and graph %s shader slots independently of shadows",
    (mode) => {
      const scene = host(false);
      updateSceneRenderingSettings(scene, { mode });
      const lamps = lights(scene, 16);
      const lowered = lowerMaterialDocument(createDefaultMaterialDocument());
      if (!lowered.ok) throw new Error("Fixture material did not lower");
      const compiled = compileMaterialPlan(lowered.plan, {
        scene,
        name: "bounded-surface",
      });
      if (!compiled.ok) throw new Error("Fixture material did not compile");
      const pbr = new PBRMaterial("native-pbr", scene);
      const standard = new StandardMaterial("native-standard", scene);
      const materials = [
        compiled.material,
        pbr,
        standard,
        new CelMaterial(pbr, scene),
      ];
      const budget = forwardLightBudget(scene.getEngine());
      // NullEngine's absent GL query uses the documented WebGL2 minimum, leaving
      // nine slots after the three native binding reservations.
      expect(budget.slots).toBe(9);
      for (const material of materials) {
        const defines = shaderLights(scene, material);
        expect(material.maxSimultaneousLights).toBe(9);
        expect(defines.LIGHT8).toBe(true);
        expect(defines.LIGHT9).not.toBe(true);
        expect(defines.MAXLIGHTCOUNT).toBe(9);
      }
      expect(lamps.filter(isForwardLightExcluded)).toHaveLength(7);
      expect(lamps.every((light) => !light.getShadowGenerator())).toBe(true);
      expect(sceneLightingLimits(scene)[0]).toContain(
        "9/16 requested lights admitted",
      );
      expect(createRenderDiagnostics(scene, () => 0)().qualityLimits).toEqual(
        expect.arrayContaining([expect.stringContaining("9 shader slots")]),
      );
    },
  );

  it("updates a full budget after camera movement and honors explicit priority without losing authored Enabled", () => {
    const scene = host(false);
    const camera = new UniversalCamera("camera", Vector3.Zero(), scene);
    scene.activeCamera = camera;
    const lamps = lights(scene, 10);
    lamps.forEach((light, index) => light.position.set(index * 10, 0, 0));
    const material = new StandardMaterial("receiver", scene);
    syncSceneLighting(scene);
    material.freeze();
    expect(isForwardLightExcluded(lamps[9]!)).toBe(true);
    const refresh = vi.spyOn(material, "markDirty");
    camera.position.x = 90;
    beginFrame(scene);
    expect(isForwardLightExcluded(lamps[0]!)).toBe(true);
    expect(lamps[9]!.isEnabled()).toBe(true);
    expect(refresh).toHaveBeenCalled();
    expect(material.isFrozen).toBe(true);
    lamps[0]!.renderPriority = 10;
    beginFrame(scene);
    expect(lamps[0]!.isEnabled()).toBe(true);
    expect(isForwardLightExcluded(lamps[1]!)).toBe(true);
    setAuthoredLightEnabled(lamps[0]!, false);
    beginFrame(scene);
    expect(lamps[0]!.isEnabled()).toBe(false);
    expect(lamps[1]!.isEnabled()).toBe(true);
    expect(lamps[0]!.renderPriority).toBe(10);
    expect(sceneLightingLimits(scene)).toEqual([]);
  });

  it.each(["point", "spot"] as const)(
    "ranks parented %s lights in current world space and promotes them after ancestor movement",
    (kind) => {
      const scene = host(false);
      scene.activeCamera = new UniversalCamera("camera", Vector3.Zero(), scene);
      const ancestor = new TransformNode("ancestor", scene);
      ancestor.position.x = 30;
      const parent = new TransformNode("parent", scene);
      parent.parent = ancestor;
      parent.position.x = 20;
      const position = new Vector3(50, 0, 0);
      const moving =
        kind === "point"
          ? new PointLight("moving", position, scene)
          : new SpotLight("moving", position, Vector3.Down(), 1, 1, scene);
      moving.parent = parent;
      const fixed = new PointLight("fixed", new Vector3(60, 0, 0), scene);

      // Before any render, moving is 100 units away despite its local x of 50.
      syncForwardLightPolicy(scene, 1);
      expect(fixed.isEnabled()).toBe(true);
      expect(isForwardLightExcluded(moving)).toBe(true);

      // The excluded light must be reconsidered using its ancestor's new pose,
      // without relying on a render or an enabled light's uniform transfer.
      ancestor.position.x = -69;
      syncForwardLightPolicy(scene, 1);
      expect(moving.isEnabled()).toBe(true);
      expect(isForwardLightExcluded(fixed)).toBe(true);

      // Detachment must also stop using the former parent's cached world pose.
      moving.parent = null;
      fixed.position.x = 10;
      syncForwardLightPolicy(scene, 1);
      expect(fixed.isEnabled()).toBe(true);
      expect(isForwardLightExcluded(moving)).toBe(true);
    },
  );

  it("retains equal-distance incumbents and restores policy-excluded lights when capacity returns", () => {
    const scene = host(false);
    scene.activeCamera = new UniversalCamera("camera", Vector3.Zero(), scene);
    const left = new PointLight("left", new Vector3(-5, 0, 0), scene);
    const right = new PointLight("right", new Vector3(5, 0, 0), scene);
    syncForwardLightPolicy(scene, 1);
    expect(left.isEnabled()).toBe(true);
    (scene.activeCamera as UniversalCamera).position.x = 0.1;
    syncForwardLightPolicy(scene, 1);
    expect(left.isEnabled()).toBe(true);
    expect(isForwardLightExcluded(right)).toBe(true);
    syncForwardLightPolicy(scene, 2);
    expect(right.isEnabled()).toBe(true);
    syncForwardLightPolicy(scene, 0);
    expect(left.isEnabled()).toBe(false);
    expect(right.isEnabled()).toBe(false);
    expect(isForwardLightExcluded(left)).toBe(true);
    syncForwardLightPolicy(scene, 2);
    expect(left.isEnabled()).toBe(true);
    expect(right.isEnabled()).toBe(true);
  });

  it("does not spend shader slots on zero-intensity lights and restores their requested state", () => {
    const scene = host(false);
    const dark = new PointLight("dark", Vector3.Zero(), scene);
    const visible = new PointLight("visible", new Vector3(10, 0, 0), scene);
    dark.intensity = 0;
    setAuthoredLightEnabled(dark, true);
    expect(syncForwardLightPolicy(scene, 1)).toMatchObject({
      requested: 1,
      admitted: 1,
    });
    expect(dark.isEnabled()).toBe(false);
    expect(isForwardLightExcluded(dark)).toBe(false);
    expect(visible.isEnabled()).toBe(true);
    dark.intensity = 1;
    dark.renderPriority = 1;
    syncForwardLightPolicy(scene, 1);
    expect(dark.isEnabled()).toBe(true);
    expect(isForwardLightExcluded(visible)).toBe(true);
  });

  it("uses one directional light and transfers illumination without changing authored intent", () => {
    const scene = host(false);
    const first = new DirectionalLight("first", Vector3.Down(), scene);
    const second = new DirectionalLight("second", Vector3.Down(), scene);
    setAuthoredLightEnabled(first, true);
    setAuthoredLightEnabled(second, true);
    expect(first.isEnabled()).toBe(true);
    expect(second.isEnabled()).toBe(false);
    setAuthoredLightEnabled(first, false);
    expect(first.isEnabled()).toBe(false);
    expect(second.isEnabled()).toBe(true);
    setAuthoredLightEnabled(first, true);
    expect(first.isEnabled()).toBe(true);
    expect(second.isEnabled()).toBe(false);
    first.dispose();
    syncDirectionalLightPolicy(scene);
    expect(second.isEnabled()).toBe(true);
  });

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
    // The UBO path reads the sixth block member rather than a standalone
    // vLightData5 uniform. Assert actual point-light evaluation uses it.
    expect(mesh.subMeshes[0]!.effect?.fragmentSourceCode).toContain(
      "computePointAndSpotPreLightingInfo(light5.vLightData",
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

  it.each(["pbr", "cel"] as const)("refreshes frozen %s graph shadow defines after allocation and enabled changes", async (mode) => {
    const scene = host(false);
    scene.activeCamera = new UniversalCamera("camera", new Vector3(0, 1, -10), scene);
    updateSceneRenderingSettings(scene, { mode });
    scene.environmentBRDFTexture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene);
    vi.spyOn(scene.environmentBRDFTexture, "isReady").mockReturnValue(true);
    const light = new PointLight("key", new Vector3(0, 3, -4), scene);
    const controller = sceneShadowController(scene);
    controller.register(light, true);
    controller.sync();
    const lowered = lowerMaterialDocument(createDefaultMaterialDocument());
    if (!lowered.ok) throw new Error("Fixture material did not lower");
    const compiled = compileMaterialPlan(lowered.plan, { scene, name: "receiver" });
    if (!compiled.ok) throw new Error("Fixture material did not compile");
    const material = compiled.material;
    const mesh = MeshBuilder.CreateBox("receiver", {}, scene);
    mesh.receiveShadows = true;
    mesh.material = material;
    material.allowShaderHotSwapping = false;
    material.freeze();
    const check = async (shadowed: boolean) => {
      beginFrame(scene);
      await vi.waitFor(() => expect(material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)).toBe(true));
      const defines = mesh.subMeshes[0]!.effect!.defines;
      expect(defines).toContain("#define LIGHT0");
      expect(defines.includes("#define SHADOW0")).toBe(shadowed);
      expect(material.isFrozen).toBe(true);
    };
    await check(true);
    controller.register(light, false);
    controller.sync();
    await check(false);
    controller.register(light, true);
    controller.sync();
    await check(true);
    light.shadowEnabled = false;
    await check(false);
    light.shadowEnabled = true;
    await check(true);
    scene.shadowsEnabled = false;
    await check(false);
    scene.shadowsEnabled = true;
    await check(true);
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
