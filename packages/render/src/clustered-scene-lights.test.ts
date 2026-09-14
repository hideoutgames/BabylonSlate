import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FreeCamera,
  MeshBuilder,
  NullEngine,
  PBRMaterial,
  PointLight,
  Scene,
  SpotLight,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import { ClusteredLightContainer } from "@babylonjs/core/Lights/Clustered/clusteredLightContainer";
import * as capabilities from "./clustered-light-capabilities";
import { ClusteredSceneLights } from "./clustered-scene-lights";
import {
  isAuthoredLightEnabled,
  setAuthoredLightEnabled,
} from "./light-policy";
import { applyAuthoredLightProperties } from "./scene-illumination";
import { sceneShadowController } from "./shadow-controller";
import { updateSceneRenderingSettings } from "./render-settings";
import { normalizeShadowSettings } from "@babylonslate/core";
import { syncSceneLighting } from "./scene-lighting";

const engines: NullEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
  vi.restoreAllMocks();
});

function fixture() {
  const engine = new NullEngine();
  engines.push(engine);
  // The only substituted boundary is GPU capability evidence. Container,
  // registry, light membership, shader budget and resource lifetimes stay real.
  Object.assign(engine.getCaps(), {
    texelFetch: true,
    colorBufferFloat: true,
    blendFloat: true,
    shaderFloatPrecision: 23,
  });
  vi.spyOn(capabilities, "clusteredLightCapabilities").mockReturnValue({
    supported: true,
    batchSize: 23,
    maxTextureSize: 4096,
  });
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 3, -5), scene);
  camera.minZ = 0.1;
  camera.maxZ = 50;
  scene.activeCamera = camera;
  const mesh = MeshBuilder.CreateBox("receiver", {}, scene);
  mesh.material = new StandardMaterial("surface", scene);
  const lights = Array.from({ length: 48 }, (_, index) => {
    const light = new PointLight(
      `light-${index}`,
      new Vector3(index / 48, 2, 0),
      scene,
    );
    applyAuthoredLightProperties(light, {
      enabled: true,
      castShadows: false,
      range: 12,
      intensity: 2,
      color: [0.2, 0.6, 0.8],
    });
    return light;
  });
  return { engine, scene, mesh, lights };
}

describe("explicit clustered light ownership", () => {
  it("borrows 48 enabled children once and returns disabled children without changing authored light values", () => {
    const { scene, mesh, lights } = fixture();
    const owner = new ClusteredSceneLights(scene, lights);
    const container = scene.lights.find(
      (light) => light instanceof ClusteredLightContainer,
    ) as ClusteredLightContainer;
    expect(owner.status().clustered).toBe(48);
    expect(scene.lights).toEqual([container]);
    expect(mesh.lightSources).toEqual([container]);
    expect(lights[0]!.range).toBe(12);
    expect(lights[0]!.intensity).toBe(2);
    expect(lights[0]!.diffuse.asArray()).toEqual([0.2, 0.6, 0.8]);
    setAuthoredLightEnabled(lights[0]!, false);
    lights[1]!.intensity = 0;
    syncSceneLighting(scene);
    expect(owner.status().clustered).toBe(46);
    expect(container.lights).not.toContain(lights[0]);
    expect(container.lights).not.toContain(lights[1]);
    expect(lights[0]!.isEnabled()).toBe(false);
    expect(isAuthoredLightEnabled(lights[1]!)).toBe(true);
    lights[1]!.intensity = 2;
    setAuthoredLightEnabled(lights[0]!, true);
    syncSceneLighting(scene);
    expect(owner.status().clustered).toBe(48);
    expect(scene.lights).toEqual([container]);
    owner.dispose();
    expect(
      lights.every(
        (light) => !light.isDisposed() && scene.lights.includes(light),
      ),
    ).toBe(true);
    expect(
      scene.materials.some((material) => material.name === "ProxyMaterial"),
    ).toBe(false);
    expect(
      scene.textures.some(
        (texture) =>
          texture.name.includes("clustered") ||
          texture.name === "TileMaskTexture",
      ),
    ).toBe(false);
  });

  it("promotes an admitted spotlight out of the cluster and demotes it after shadow removal", () => {
    const { scene, mesh } = fixture();
    for (const light of scene.lights.slice()) light.dispose();
    const spot = new SpotLight(
      "spot",
      new Vector3(0, 3, 0),
      Vector3.Down(),
      Math.PI / 2,
      1,
      scene,
    );
    applyAuthoredLightProperties(spot, { castShadows: false, range: 12 });
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({
        enabled: true,
        localMapSize: 64,
        maxLocalLights: 1,
        localLightMode: "manual",
      }),
    });
    const owner = new ClusteredSceneLights(scene, [spot]);
    const controller = sceneShadowController(scene);
    expect(owner.status().clustered).toBe(1);
    applyAuthoredLightProperties(spot, { castShadows: true, range: 12 });
    syncSceneLighting(scene);
    expect(controller.generator(spot)).not.toBeNull();
    expect(owner.status().clustered).toBe(0);
    expect(mesh.lightSources.filter((light) => light === spot)).toHaveLength(1);
    expect(scene.lights.filter((light) => light === spot)).toHaveLength(1);
    applyAuthoredLightProperties(spot, { castShadows: false, range: 12 });
    syncSceneLighting(scene);
    expect(controller.generator(spot)).toBeNull();
    expect(owner.status().clustered).toBe(1);
    expect(mesh.lightSources).not.toContain(spot);
    owner.dispose();
  });

  it("detaches disposed children and preserves a sibling Scene during owner disposal", () => {
    const { engine, scene, lights } = fixture();
    const sibling = new Scene(engine);
    const siblingLight = new PointLight("sibling", Vector3.Zero(), sibling);
    const owner = new ClusteredSceneLights(scene, lights);
    lights[0]!.dispose();
    syncSceneLighting(scene);
    expect(owner.status().clustered).toBe(47);
    expect(scene.lights).not.toContain(lights[0]);
    owner.dispose();
    expect(sibling.lights).toEqual([siblingLight]);
    expect(siblingLight.isDisposed()).toBe(false);
  });

  it("keeps unsupported physical PBR attenuation on bounded conventional admission", () => {
    const { scene, mesh, lights } = fixture();
    mesh.material = new PBRMaterial("physical", scene);
    const owner = new ClusteredSceneLights(scene, lights);
    expect(owner.status().clustered).toBe(0);
    expect(owner.limits().join()).toContain("physical PBR");
    expect(scene.lights).toHaveLength(48);
    expect(lights.filter((light) => light.isEnabled()).length).toBeLessThan(48);
    expect(
      lights.every(
        (light) => isAuthoredLightEnabled(light) && light.range === 12,
      ),
    ).toBe(true);
    owner.dispose();
  });

  it("cleans a partially constructed container and reports conventional fallback after GPU allocation throws", () => {
    const { engine, scene, lights } = fixture();
    const textures = scene.textures.slice();
    const materials = scene.materials.slice();
    const renderers = scene.objectRenderers.slice();
    const wrappers = engine._renderTargetWrapperCache.slice();
    vi.spyOn(engine, "createRenderTargetTexture").mockImplementationOnce(() => {
      throw new Error("GPU allocation rejected");
    });
    const owner = new ClusteredSceneLights(scene, lights);
    expect(owner.status().clustered).toBe(0);
    expect(owner.limits().join()).toContain("GPU allocation rejected");
    expect(scene.lights).toHaveLength(48);
    expect(scene.textures).toEqual(textures);
    expect(scene.materials).toEqual(materials);
    expect(scene.objectRenderers).toEqual(renderers);
    expect(engine._renderTargetWrapperCache).toEqual(wrappers);
    owner.dispose();
  });
});
