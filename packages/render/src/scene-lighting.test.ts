import {
  isForwardLightExcluded,
  setAuthoredLightEnabled,
  syncDirectionalLightPolicy,
  syncForwardLightPolicy,
} from "./light-policy";
import { deviceProfile } from "./device-profile";
import { HapticLightingBlock } from "./haptic-lighting-block";
import { hapticLightBuffer } from "./haptic-lights";
import { restoreSceneLightOrder, sortReceiverLightSources } from "./forward-light-slots";
import { sceneLightingLimits, syncSceneLighting } from "./scene-lighting";
import { updateSceneRenderingSettings } from "./render-settings";
import { createRenderDiagnostics } from "./render-diagnostics";
import {
  DirectionalLight,
  MaterialDefines,
  MaterialHelper,
  MeshBuilder,
  NullEngine,
  NullEngineOptions,
  type NodeMaterial,
  PBRMaterial,
  PointLight,
  RectAreaLight,
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
} from "@haptic/shader-graph";
import { compileMaterialPlan } from "./material-compiler";
import { setupDefaultViewport } from "./viewport";
import { sceneShadowController } from "./shadow-controller";
import { AtlasShadowGenerator } from "./shadow-atlas";
import { ViewportShadingOverlay } from "./viewport-shading-mode";
import { normalizeRenderingQuality, qualityPresetPatch } from "@haptic/core";
import { retainAreaLightLookup } from "./area-light-resources";

const engines: NullEngine[] = [];

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

function host(viewport = true) {
  const options = new NullEngineOptions();
  // Babylon's headless WebGL2/multiview option, as a shipped WebGL2 Engine.
  options.enableMultiview = true;
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
  expect(locals.filter((light) => light.isEnabled())).toHaveLength(6);
  expect(locals.filter(isForwardLightExcluded)).toHaveLength(1);
  expect(sceneLightingLimits(scene).join()).toContain("6 scalability local lights");
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

/** The light block's counts (sun, point, spot, rect) and fill presence, as the next frame draws them. */
function blockLights(scene: Scene): number[] {
  syncSceneLighting(scene);
  return [...blockRead(scene, "hapticCounts", 0, 4), blockRead(scene, "hapticFillDirection", 3, 1)[0]!];
}

/** The first point light record's shadow: its first shadow view and face count. */
function pointShadow(scene: Scene): number[] {
  return blockRead(scene, "hapticPoint", 8, 2);
}

function blockRead(scene: Scene, name: string, from: number, length: number): number[] {
  const buffer = hapticLightBuffer(scene) as unknown as { _bufferData: Float32Array; _uniformLocations: Record<string, number> };
  const start = buffer._uniformLocations[name]! + from;
  return [...buffer._bufferData.subarray(start, start + length)];
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
  it.each(["pbr", "cel"] as const)(
    "bounds the lights the block admits by this device's maximum independently of shadows in %s",
    (mode) => {
      const scene = host(false);
      updateSceneRenderingSettings(scene, { mode });
      const maximum = deviceProfile().lightMaximum.point;
      const lamps = lights(scene, maximum + 8);
      const lowered = lowerMaterialDocument(createDefaultMaterialDocument());
      if (!lowered.ok) throw new Error("Fixture material did not lower");
      const compiled = compileMaterialPlan(lowered.plan, {
        scene,
        name: "bounded-surface",
      });
      if (!compiled.ok) throw new Error("Fixture material did not compile");
      syncSceneLighting(scene);
      // The block has no shader slots: the graph reads every admitted light from it.
      expect(blockLights(scene)).toEqual([0, maximum, 0, 0, 0]);
      expect(lamps.filter(isForwardLightExcluded)).toEqual(lamps.slice(maximum));
      expect(lamps.every((light) => !light.getShadowGenerator())).toBe(true);
      expect(sceneLightingLimits(scene)[0]).toContain(
        `Light block: ${maximum}/${maximum + 8} requested lights admitted`,
      );
      expect(createRenderDiagnostics(scene, () => 0)().qualityLimits).toEqual(
        expect.arrayContaining([expect.stringContaining(`at most ${maximum} point`)]),
      );
    },
  );

  it("updates a full budget after camera movement and honors explicit priority without losing authored Enabled", () => {
    const scene = host(false);
    const camera = new UniversalCamera("camera", Vector3.Zero(), scene);
    scene.activeCamera = camera;
    // Nine local lights for ten lamps.
    updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality({ lighting: { localLightMode: "manual", maxLocalLights: 9 } }) });
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

  it("lights the default material with the fifth and sixth scene lights from the block", () => {
    const scene = host();
    lights(scene, 6);
    expect((scene.defaultMaterial as NodeMaterial).attachedBlocks.some((block) => block instanceof HapticLightingBlock)).toBe(true);
    expect(blockLights(scene)).toEqual([0, 6, 0, 0, 0]);
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
    expect(compiled.material.attachedBlocks.some((block) => block instanceof HapticLightingBlock)).toBe(true);
    expect(blockLights(scene)).toEqual([0, 6, 0, 0, 0]);
    // Babylon's own materials keep its lights, one shader slot each.
    for (const material of [
      new PBRMaterial("imported", scene),
      new StandardMaterial("imported-standard", scene),
    ]) {
      expect(shaderLights(scene, material).LIGHT5).toBe(true);
    }
  });

  it("lights a frozen graph Material with lights that arrive or leave after it compiled, keeping its Effect", async () => {
    const scene = host();
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
    const drawn = async () => {
      beginFrame(scene);
      await vi.waitFor(() =>
        expect(material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)).toBe(true),
      );
      return mesh.subMeshes[0]!.effect;
    };
    const effect = await drawn();
    expect(effect?.defines).not.toMatch(/#define LIGHT\d/);
    expect(blockLights(scene)[1]).toBe(3);

    const added = lights(scene, 3);
    expect(await drawn()).toBe(effect);
    expect(blockLights(scene)[1]).toBe(6);

    added[2]!.dispose();
    expect(await drawn()).toBe(effect);
    expect(blockLights(scene)[1]).toBe(5);
    expect(material.isFrozen).toBe(true);
  });

  it.each(["pbr", "cel"] as const)("shadows a frozen %s graph from the block after allocation and enabled changes, keeping its Effect", async (mode) => {
    const scene = host(false);
    // A point light's map is six tiles of the shadow atlas, which a NullEngine's 512 texel texture limit cannot hold.
    scene.getEngine().getCaps().maxTextureSize = 4096;
    scene.activeCamera = new UniversalCamera("camera", new Vector3(0, 1, -10), scene);
    updateSceneRenderingSettings(scene, { mode });
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
    let effect: unknown;
    const check = async (shadowed: boolean) => {
      beginFrame(scene);
      await vi.waitFor(() => expect(material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)).toBe(true));
      effect ??= mesh.subMeshes[0]!.effect;
      // A light's shadow is its record's first shadow view and face count, -1 and 0 for none; no define follows it.
      expect(mesh.subMeshes[0]!.effect).toBe(effect);
      expect(pointShadow(scene)).toEqual(shadowed ? [expect.any(Number), 6] : [-1, 0]);
      if (shadowed) expect(pointShadow(scene)[0]).toBeGreaterThanOrEqual(0);
      expect(material.isFrozen).toBe(true);
    };
    await check(true);
    expect(controller.generator(light)).toBeInstanceOf(AtlasShadowGenerator);
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

  it("keeps a receiver's Effect when a light it cannot see is turned off, on or removed", async () => {
    const scene = host();
    const lamps = lights(scene, 6);
    const material = new StandardMaterial("receiver", scene);
    const mesh = MeshBuilder.CreateBox("receiver", {}, scene);
    mesh.material = material;
    // Five lamps reach the receiver; the sixth only changes the scene's enabled count.
    lamps[5]!.excludedMeshes.push(mesh);
    const compile = async () => {
      beginFrame(scene);
      await material.forceCompilationAsync(mesh);
      material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!);
      return mesh.subMeshes[0]!.effect;
    };
    const effect = await compile();
    expect(effect?.defines).toContain("#define LIGHT4");
    expect(effect?.defines).not.toContain("#define LIGHT5");
    setAuthoredLightEnabled(lamps[5]!, false);
    expect(await compile()).toBe(effect);
    setAuthoredLightEnabled(lamps[5]!, true);
    expect(await compile()).toBe(effect);
    lamps[5]!.dispose();
    expect(await compile()).toBe(effect);
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

  describe("receiver light order", () => {
    // Ten lamps 10 m apart; the lamp at each index of `spots` is a spot light.
    function swapFixture(spots: readonly number[] = [], x = (index: number) => index * 10) {
      const scene = host(false);
      const camera = new UniversalCamera("camera", Vector3.Zero(), scene);
      scene.activeCamera = camera;
      const lamps = Array.from({ length: 10 }, (_, index) => {
        const position = new Vector3(x(index), 3, 0);
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

    it("restores a recorded light order around a light added since and without one removed since", () => {
      const scene = host(false);
      const [a, b, c, d] = ["a", "b", "c", "d"].map((name) => new PointLight(name, Vector3.Zero(), scene));
      const order = [a!, b!, c!, d!];
      // Exchanges permuted the lights, d left the scene and e arrived.
      scene.removeLight(d!);
      const e = new PointLight("e", Vector3.Zero(), scene);
      scene.lights.splice(0, scene.lights.length, c!, e, a!, b!);
      expect(restoreSceneLightOrder(scene, order)).toBe(true);
      expect(scene.lights.map((light) => light.name)).toEqual(["a", "e", "b", "c"]);
      expect(restoreSceneLightOrder(scene, order)).toBe(false);
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
    expect(blockLights(scene)).toEqual([0, 0, 0, 0, 0]);
    overlay.setMode("pbr");
    expect(blockLights(scene)).toEqual([0, 6, 0, 0, 0]);
  });
});
