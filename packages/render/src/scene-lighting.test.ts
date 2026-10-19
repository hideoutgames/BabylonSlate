import { installAssetBytes } from "@babylonslate/assets";
import {
  isForwardLightExcluded,
  setAuthoredLightEnabled,
  syncDirectionalLightPolicy,
  syncForwardLightPolicy,
} from "./light-policy";
import { forwardLightBudget } from "./forward-light-budget";
import { sortReceiverLightSources } from "./forward-light-slots";
import { sceneLightingLimits, syncSceneLighting } from "./scene-lighting";
import { CelMaterial } from "./cel-material";
import { updateSceneRenderingSettings } from "./render-settings";
import { createRenderDiagnostics } from "./render-diagnostics";
import {
  DirectionalLight,
  MaterialDefines,
  MaterialHelper,
  MeshBuilder,
  type Mesh,
  NullEngine,
  NullEngineOptions,
  PBRMaterial,
  PointLight,
  RawTexture,
  RectAreaLight,
  Scene,
  ShadowGenerator,
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
import { sceneShadowController, shadowLightDiagnostics } from "./shadow-controller";
import { ViewportShadingOverlay } from "./viewport-shading-mode";
import { beginSlotModelAnimLoad, createModelActorRoot } from "./glb-anim";
import { encodeUvHierarchyGlb } from "./glb-test-fixtures";
import { createSnapshotSceneBinding } from "./snapshot-apply";
import { visualMeshes } from "./visual-meshes";
import { normalizeRenderingQuality, qualityPresetPatch } from "@babylonslate/core";
import { retainAreaLightLookup } from "./area-light-resources";

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

it("applies local lighting scalability without suppressing the sun and restores eligible lights on a higher preset", () => {
  const scene = host(false);
  scene.activeCamera = new UniversalCamera("camera", Vector3.Zero(), scene);
  const sun = new DirectionalLight("sun", Vector3.Down(), scene);
  const locals = lights(scene, 7);
  const apply = (level: "low" | "medium") => {
    updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality(qualityPresetPatch(level)) });
    syncSceneLighting(scene);
  };
  apply("low");
  expect(sun.isEnabled()).toBe(true);
  expect(locals.filter((light) => light.isEnabled())).toHaveLength(4);
  expect(locals.filter(isForwardLightExcluded)).toHaveLength(3);
  expect(sceneLightingLimits(scene).join()).toContain("4 scalability local lights");
  const manual = normalizeRenderingQuality(qualityPresetPatch("low"));
  manual.lighting.localLightMode = "manual";
  manual.lighting.maxLocalLights = 5;
  updateSceneRenderingSettings(scene, { quality: manual });
  syncSceneLighting(scene);
  expect(sun.isEnabled()).toBe(true);
  expect(locals.filter((light) => light.isEnabled())).toHaveLength(5);
  apply("medium");
  expect(sun.isEnabled()).toBe(true);
  expect(locals.every((light) => light.isEnabled())).toBe(true);
});

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
  it("admits textured rectangles within shared sampler headroom and restores them without changing authored state", () => {
    const scene = host(false);
    scene.getEngine().getCaps().maxTexturesImageUnits = 12;
    scene.onDisposeObservable.addOnce(retainAreaLightLookup(scene));
    const texture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene);
    const areas = Array.from({ length: 4 }, (_, index) => {
      const light = new RectAreaLight(`area-${index}`, Vector3.Zero(), 2, 2, scene);
      light.emissionTexture = texture;
      return light;
    });
    const uniform = new RectAreaLight("uniform", Vector3.Zero(), 2, 2, scene);
    const sun = new DirectionalLight("sun", Vector3.Down(), scene);
    syncSceneLighting(scene);
    expect(areas.filter((light) => light.isEnabled())).toHaveLength(2);
    expect(uniform.isEnabled()).toBe(true);
    expect(sun.isEnabled()).toBe(true);
    expect(sceneLightingLimits(scene).join()).toContain("4/4 lighting samplers, 2 limited by sampler headroom");
    scene.getEngine().getCaps().maxTexturesImageUnits = 16;
    syncSceneLighting(scene);
    expect(areas.every((light) => light.isEnabled())).toBe(true);
    expect(areas.every((light) => light.emissionTexture === texture)).toBe(true);
    expect(sceneLightingLimits(scene)).toEqual([]);
  });

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
    camera.position.x = 90;
    beginFrame(scene);
    expect(isForwardLightExcluded(lamps[0]!)).toBe(true);
    expect(lamps[9]!.isEnabled()).toBe(true);
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

  it.each(["point", "spot", "area"] as const)(
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
      if (kind === "area") scene.onDisposeObservable.addOnce(retainAreaLightLookup(scene));
      // Babylon's base Light.getAbsolutePosition() is the origin for area lights.
      const moving =
        kind === "point"
          ? new PointLight("moving", position, scene)
          : kind === "spot"
            ? new SpotLight("moving", position, Vector3.Down(), 1, 1, scene)
            : new RectAreaLight("moving", position, 1, 1, scene);
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

  it("puts a re-enabled sun back in its scene-order slot so receivers ask for the shader they compiled before", () => {
    const scene = host(false);
    scene.activeCamera = new UniversalCamera("camera", Vector3.Zero(), scene);
    const sun = new DirectionalLight("sun", Vector3.Down(), scene);
    const locals = lights(scene, 3);
    const material = new StandardMaterial("receiver", scene);
    const receiver = MeshBuilder.CreateBox("receiver", {}, scene);
    receiver.material = material;
    const part = receiver.subMeshes[0]!;
    syncSceneLighting(scene);
    material.isReadyForSubMesh(receiver, part);
    const defines = part.materialDefines!.toString();
    const effect = part.effect;
    setAuthoredLightEnabled(sun, false);
    beginFrame(scene);
    material.isReadyForSubMesh(receiver, part);
    // Babylon appends a re-enabled light after every light the receiver kept.
    setAuthoredLightEnabled(sun, true);
    beginFrame(scene);
    expect(receiver.lightSources).toEqual([sun, ...locals]);
    material.isReadyForSubMesh(receiver, part);
    expect(part.materialDefines!.toString()).toBe(defines);
    expect(part.effect).toBe(effect);
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
      installAssetBytes(encodeUvHierarchyGlb({ separateMaterials: true })),
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
    const engine = scene.getEngine();
    // Babylon 9.29 NullEngine omits attaching its cube InternalTexture to the
    // wrapper. Complete that headless allocation boundary, keeping real maps.
    const createCube = engine.createRenderTargetCubeTexture.bind(engine);
    engine.createRenderTargetCubeTexture = (...args) => {
      const target = createCube(...args);
      target.setTexture(engine.getLoadedTexturesCache().at(-1)!);
      return target;
    };
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
    const added = new Promise<void>((resolve) => scene.onNewMeshAddedObservable.addOnce(() => resolve()));
    const mesh = MeshBuilder.CreateBox("receiver", {}, scene);
    mesh.receiveShadows = true;
    mesh.material = material;
    await added;
    controller.sync();
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
    expect(controller.generator(light)?.getShadowMap()?.renderList).toContain(mesh);
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

  describe("Forward budget swaps", () => {
    // Nine shader slots; ten lamps 10 m apart. The first sync drops lamp 9 and
    // orders the admitted lamps points first, then spots, each in creation
    // order. With the camera at x = 90 the budget drops lamp 0 and admits lamp 9.
    function swapFixture(spots: readonly number[] = []) {
      const scene = host(false);
      const camera = new UniversalCamera("camera", Vector3.Zero(), scene);
      scene.activeCamera = camera;
      const lamps = Array.from({ length: 10 }, (_, index) => {
        const position = new Vector3(index * 10, 3, 0);
        return spots.includes(index)
          ? new SpotLight(`lamp-${index}`, position, Vector3.Down(), 1, 1, scene)
          : new PointLight(`lamp-${index}`, position, scene);
      });
      const material = new StandardMaterial("receiver", scene);
      const receiver = MeshBuilder.CreateBox("receiver", {}, scene);
      receiver.material = material;
      syncSceneLighting(scene);
      const part = receiver.subMeshes[0]!;
      material.isReadyForSubMesh(receiver, part);
      expect(part.materialDefines!.isDirty).toBe(false);
      return { scene, camera, lamps, material, receiver, part };
    }
    // A frozen material skips re-preparation only once its effect is ready.
    const ready = (mesh: Mesh, material: Material) =>
      vi.waitFor(() => expect(material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)).toBe(true));
    // Re-prepare from the current light order to see which defines it yields.
    const prepared = (mesh: Mesh, material: Material) => {
      mesh._markSubMeshesAsLightDirty();
      material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!);
      return mesh.subMeshes[0]!.materialDefines!.toString();
    };
    const slotKinds = (defines: string) =>
      Array.from({ length: 9 }, (_, index) =>
        defines.includes(`#define SPOTLIGHT${index}\n`)
          ? "spot"
          : defines.includes(`#define POINTLIGHT${index}\n`)
            ? "point"
            : "none",
      );
    const points = (count: number) => Array.from({ length: count }, () => "point");

    it("puts the admitted light in the dropped light's slot without dirtying or recompiling receivers when the slot defines match", async () => {
      const { scene, camera, lamps, material, receiver, part } = swapFixture([4]);
      material.freeze();
      await ready(receiver, material);
      const effect = part.effect;
      const defines = part.materialDefines!.toString();
      const invalidate = vi.spyOn(material, "markAsDirty");
      camera.position.x = 90;
      beginFrame(scene);
      expect(isForwardLightExcluded(lamps[0]!)).toBe(true);
      // Every other light keeps its index, so the spot stays in the last slot.
      expect(receiver.lightSources).toEqual([9, 1, 2, 3, 5, 6, 7, 8, 4].map((index) => lamps[index]));
      expect(part.materialDefines!.isDirty).toBe(false);
      expect(invalidate).not.toHaveBeenCalled();
      expect(material.isFrozen).toBe(true);
      // Re-preparing from the new order asks only for the compiled effect.
      material.unfreeze();
      const create = vi.spyOn(scene.getEngine(), "createEffect");
      expect(prepared(receiver, material)).toBe(defines);
      expect(create).toHaveBeenCalled();
      expect(create.mock.results.every(({ value }) => value === effect)).toBe(true);
      expect(part.effect).toBe(effect);
      // A mesh added later builds its order from scene.lights and matches.
      const later = MeshBuilder.CreateBox("later", {}, scene);
      later.material = material;
      expect(later.lightSources).toEqual(receiver.lightSources);
      // Diagnostics keep listing lights in creation order.
      expect(shadowLightDiagnostics(scene).map(({ name }) => name)).toEqual(
        lamps.map(({ name }) => name),
      );
    });

    it("re-sorts the admitted lights by slot kind and refreshes frozen receivers when the slot defines differ", async () => {
      const { scene, camera, lamps, material, receiver, part } = swapFixture([0, 4]);
      material.freeze();
      await ready(receiver, material);
      expect(slotKinds(part.materialDefines!.toString())).toEqual([...points(7), "spot", "spot"]);
      camera.position.x = 90;
      beginFrame(scene);
      // The admitted point joins the points; the remaining spot moves to the end.
      expect(receiver.lightSources).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 4].map((index) => lamps[index]));
      material.isReadyForSubMesh(receiver, part);
      expect(slotKinds(part.materialDefines!.toString())).toEqual([...points(8), "spot"]);
      expect(material.isFrozen).toBe(true);
    });

    it("rebuilds the shader a revisited light set compiled before, after a chain of different-kind swaps", () => {
      const scene = host(false);
      const camera = new UniversalCamera("camera", Vector3.Zero(), scene);
      scene.activeCamera = camera;
      // Two spot and two point corner lamps; six points near the centre stay
      // admitted. With the camera opposite a corner, that corner is farthest
      // and the nine-slot budget drops it.
      const corners = [new Vector3(40, 3, 40), new Vector3(-40, 3, 40), new Vector3(-40, 3, -40), new Vector3(40, 3, -40)];
      const lamps = corners.map((position, index) =>
        index < 2
          ? new SpotLight(`corner-${index}`, position, Vector3.Down(), 1, 1, scene)
          : new PointLight(`corner-${index}`, position, scene));
      for (let index = 0; index < 6; index++) new PointLight(`centre-${index}`, new Vector3(index - 2.5, 3, 0), scene);
      const material = new StandardMaterial("receiver", scene);
      const receiver = MeshBuilder.CreateBox("receiver", {}, scene);
      receiver.material = material;
      const part = receiver.subMeshes[0]!;
      syncSceneLighting(scene);
      const exclude = (corner: number) => {
        camera.position.copyFrom(corners[corner]!).scaleInPlace(-1);
        beginFrame(scene);
        expect(isForwardLightExcluded(lamps[corner]!)).toBe(true);
        material.isReadyForSubMesh(receiver, part);
        return { defines: part.materialDefines!.toString(), effect: part.effect };
      };
      const first = exclude(0);
      exclude(1); // spot for spot
      exclude(2); // spot for point
      const revisit = exclude(0); // point for spot: the first light set again
      expect(revisit.defines).toBe(first.defines);
      expect(revisit.effect).toBe(first.effect);
    });

    it("refreshes a frozen receiver the admitted light excludes, which only loses the dropped light", async () => {
      const { scene, camera, lamps, material, receiver } = swapFixture([4]);
      const excluded = MeshBuilder.CreateBox("excluded", {}, scene);
      excluded.material = material;
      lamps[9]!.excludedMeshes.push(excluded);
      material.freeze();
      await ready(receiver, material);
      await ready(excluded, material);
      camera.position.x = 90;
      beginFrame(scene);
      expect(receiver.lightSources).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 4].map((index) => lamps[index]));
      expect(excluded.lightSources).toEqual([1, 2, 3, 5, 6, 7, 8, 4].map((index) => lamps[index]));
      material.isReadyForSubMesh(excluded, excluded.subMeshes[0]!);
      // Its later lights moved down one slot, so its shader must follow.
      expect(slotKinds(excluded.subMeshes[0]!.materialDefines!.toString())).toEqual([...points(7), "spot", "none"]);
      expect(material.isFrozen).toBe(true);
    });

    it("refreshes frozen receivers when the dropped light still has a shadow map", async () => {
      const { scene, camera, lamps, material, receiver, part } = swapFixture([0, 9]);
      receiver.receiveShadows = true;
      const generator = new ShadowGenerator(64, lamps[0] as SpotLight);
      generator.addShadowCaster(MeshBuilder.CreateBox("caster", {}, scene));
      beginFrame(scene);
      material.freeze();
      await ready(receiver, material);
      // The spot follows the eight points.
      expect(part.materialDefines!.toString()).toContain("#define SHADOW8\n");
      camera.position.x = 90;
      beginFrame(scene);
      // A standby map stays attached to the dropped light; the admitted spot has none.
      expect(lamps[0]!.getShadowGenerator()).toBe(generator);
      expect(receiver.lightSources[8]).toBe(lamps[9]);
      material.isReadyForSubMesh(receiver, part);
      const defines = part.materialDefines!.toString();
      expect(defines).toContain("#define SPOTLIGHT8\n");
      expect(defines).not.toContain("#define SHADOW8\n");
    });

    it("re-sorts a receiver to scene order without dirtying it when only lights with one slot signature move", () => {
      const { scene, lamps, material, receiver, part } = swapFixture([4]);
      const other = MeshBuilder.CreateBox("other", {}, scene);
      other.material = material;
      material.isReadyForSubMesh(other, other.subMeshes[0]!);
      const sources = receiver.lightSources;
      const order = sources.slice();
      // Two points trade places in one receiver, two lights of different kinds in the other.
      [sources[0], sources[1]] = [sources[1]!, sources[0]!];
      const spot = other.lightSources.indexOf(lamps[4]!);
      [other.lightSources[0], other.lightSources[spot]] = [other.lightSources[spot]!, other.lightSources[0]!];
      expect(sortReceiverLightSources(scene)).toBe(true);
      expect(receiver.lightSources).toEqual(order);
      expect(other.lightSources).toEqual(order);
      expect(part.materialDefines!.isDirty).toBe(false);
      expect(other.subMeshes[0]!.materialDefines!.isDirty).toBe(true);
    });

    it("hands an exchange back to Babylon when the admitted light's parent is the dropped light", async () => {
      const scene = host(false);
      const camera = new UniversalCamera("camera", Vector3.Zero(), scene);
      scene.activeCamera = camera;
      const lamps = Array.from(
        { length: 9 },
        (_, index) => new PointLight(`lamp-${index}`, new Vector3(index * 10, 3, 0), scene),
      );
      const child = new PointLight("child", new Vector3(95, -3, 0), scene);
      child.parent = lamps[0]!;
      const material = new StandardMaterial("receiver", scene);
      const receiver = MeshBuilder.CreateBox("receiver", {}, scene);
      receiver.material = material;
      syncSceneLighting(scene);
      expect(isForwardLightExcluded(child)).toBe(true);
      material.freeze();
      await ready(receiver, material);
      camera.position.x = 95;
      beginFrame(scene);
      // Dropping lamp 0 also disables its child, so neither lights the receiver.
      expect(isForwardLightExcluded(lamps[0]!)).toBe(true);
      expect(child.isEnabled()).toBe(false);
      expect(receiver.lightSources).toEqual(lamps.slice(1));
      // The undone exchange leaves the lit lamps first, then the two unlit ones.
      expect(scene.lights).toEqual([...lamps.slice(1), lamps[0], child]);
      material.isReadyForSubMesh(receiver, receiver.subMeshes[0]!);
      expect(slotKinds(receiver.subMeshes[0]!.materialDefines!.toString())).toEqual(
        [...Array.from({ length: 8 }, () => "point"), "none"],
      );
    });
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
