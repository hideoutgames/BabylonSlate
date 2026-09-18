import {
  createDefaultMaterialDocument,
  lowerMaterialDocument,
} from "@babylonslate/shader-graph";
import { compileMaterialPlan } from "./material-compiler";
import { createEditorGrid } from "./editor-grid";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Camera,
  FreeCamera,
  MeshBuilder,
  NullEngine,
  PBRMaterial,
  PointLight,
  Scene,
  ShaderMaterial,
  Vector3,
} from "@babylonjs/core";
import { ClusteredLightContainer } from "@babylonjs/core/Lights/Clustered/clusteredLightContainer";
import { normalizeRenderingQuality } from "@babylonslate/core";
import * as capabilities from "./clustered-light-capabilities";
import { applyAuthoredLightProperties } from "./scene-illumination";
import {
  sceneRenderPathStatus,
  subscribeSceneRenderPath,
} from "./scene-render-path";
import { requestRenderPath } from "./render-path-session";
import { setSceneRenderSettings } from "./scene-render-mode";
import { syncSceneLighting } from "./scene-lighting";
import { isAuthoredLightEnabled } from "./light-policy";

const engines: NullEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
  vi.restoreAllMocks();
});
function fixture(engine = new NullEngine()) {
  if (!engines.includes(engine)) engines.push(engine);
  vi.spyOn(engine, "version", "get").mockReturnValue(2);
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
  // Pinned NullEngine omits the requested RTT format, unlike real WebGL.
  if (!vi.isMockFunction(engine.createRenderTargetTexture)) {
    const createTargetWithFormat =
      engine.createRenderTargetTexture.bind(engine);
    vi.spyOn(engine, "createRenderTargetTexture").mockImplementation(
      (size, options) => {
        const target = createTargetWithFormat(size, options);
        if (
          target.texture &&
          typeof options === "object" &&
          options.format !== undefined
        )
          target.texture.format = options.format;
        return target;
      },
    );
  }
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 3, -5), scene);
  camera.minZ = 0.1;
  camera.maxZ = 50;
  scene.activeCamera = camera;
  const mesh = MeshBuilder.CreateBox("surface", {}, scene);
  mesh.material = new PBRMaterial("PBR", scene);
  const lights = Array.from({ length: 8 }, (_, index) => {
    const light = new PointLight(
      `point-${index}`,
      new Vector3(index, 2, 0),
      scene,
    );
    applyAuthoredLightProperties(light, {
      enabled: true,
      castShadows: false,
      range: 12,
      intensity: 2,
    });
    return light;
  });
  return { engine, scene, camera, mesh, lights };
}
function container(scene: Scene) {
  return scene.lights.find(
    (light) => light instanceof ClusteredLightContainer,
  ) as ClusteredLightContainer | undefined;
}

describe("scene render path selection", () => {
  it("preserves the requested path and reports an enabled native feature qualification fallback", () => {
    const { scene, mesh } = fixture();
    const material = mesh.material as PBRMaterial;
    setSceneRenderSettings(scene, { renderPath: "clusteredForward" });
    expect(container(scene)).toBeDefined();
    material.clearCoat.isEnabled = true;
    syncSceneLighting(scene);
    expect(container(scene)).toBeUndefined();
    expect(sceneRenderPathStatus(scene).requested.renderPath).toBe(
      "clusteredForward",
    );
    expect(sceneRenderPathStatus(scene).effective.renderPath).toBe("forward");
    expect(sceneRenderPathStatus(scene).limits.join()).toContain("Clear Coat");
    material.clearCoat.isEnabled = false;
    syncSceneLighting(scene);
    expect(container(scene)).toBeDefined();
  });

  it("owns one container for an explicit request and restores authored lights on Forward and disposal", () => {
    const { scene, lights } = fixture();
    const listener = vi.fn();
    const unsubscribe = subscribeSceneRenderPath(scene, listener);
    setSceneRenderSettings(scene, { renderPath: "clusteredForward" });
    const owner = container(scene)!;
    expect(owner).toBeDefined();
    expect(owner.lights).toHaveLength(8);
    expect(sceneRenderPathStatus(scene).effective.renderPath).toBe(
      "clusteredForward",
    );
    for (let i = 0; i < 3; i++) syncSceneLighting(scene);
    expect(container(scene)).toBe(owner);
    expect(listener).toHaveBeenCalledTimes(2);
    setSceneRenderSettings(scene, { renderPath: "forward" });
    expect(owner.isDisposed()).toBe(true);
    expect(container(scene)).toBeUndefined();
    expect(scene.lights).toEqual(lights);
    expect(lights.every(isAuthoredLightEnabled)).toBe(true);
    setSceneRenderSettings(scene, { renderPath: "clusteredForward" });
    const second = container(scene)!;
    unsubscribe();
    scene.dispose();
    expect(second.isDisposed()).toBe(true);
  });

  it("keeps Auto stable across camera and light motion, with shared quality reconfiguration", () => {
    const { scene, camera, lights } = fixture();
    setSceneRenderSettings(scene, { renderPath: "auto" });
    const owner = container(scene)!;
    expect(owner).toBeDefined();
    camera.position.x = 100;
    lights[0]!.position.x = -100;
    syncSceneLighting(scene);
    expect(container(scene)).toBe(owner);
    const low = normalizeRenderingQuality({ lighting: { profile: "low" } });
    setSceneRenderSettings(scene, { renderPath: "auto", quality: low });
    expect(sceneRenderPathStatus(scene).effective.renderPath).toBe("forward");
    expect(owner.isDisposed()).toBe(true);
    setSceneRenderSettings(scene, {
      renderPath: "auto",
      quality: normalizeRenderingQuality({
        lighting: {
          profile: "low",
          localLightMode: "manual",
          maxLocalLights: 5,
        },
      }),
    });
    expect(container(scene)?.lights).toHaveLength(5);
    expect(sceneRenderPathStatus(scene).requested.renderPath).toBe("auto");
    expect(lights.every(isAuthoredLightEnabled)).toBe(true);
  });

  it("reports actual capability, camera, and material fallbacks while retaining the preference", () => {
    const { scene, camera, mesh, lights } = fixture();
    vi.mocked(capabilities.clusteredLightCapabilities).mockReturnValue({
      supported: false,
      reason: "Float blending failed the numerical probe.",
    });
    setSceneRenderSettings(scene, { renderPath: "clusteredForward" });
    expect(sceneRenderPathStatus(scene)).toMatchObject({
      requested: { renderPath: "clusteredForward" },
      effective: { renderPath: "forward" },
      limits: [expect.stringContaining("Float blending")],
    });
    expect(scene.lights).toEqual(lights);
    vi.mocked(capabilities.clusteredLightCapabilities).mockReturnValue({
      supported: true,
      batchSize: 23,
      maxTextureSize: 4096,
    });
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    syncSceneLighting(scene);
    expect(sceneRenderPathStatus(scene).limits[0]).toContain(
      "perspective camera",
    );
    camera.mode = Camera.PERSPECTIVE_CAMERA;
    syncSceneLighting(scene);
    const owner = container(scene)!;
    expect(owner).toBeDefined();
    mesh.material = new ShaderMaterial("custom-lit", scene, {}, {});
    syncSceneLighting(scene);
    expect(sceneRenderPathStatus(scene).limits[0]).toContain("custom-lit");
    expect(owner.isDisposed()).toBe(true);
    expect(scene.lights).toEqual(lights);
  });

  it("reconfigures authored topology without retaining removed lights or affecting a sibling Scene", () => {
    const first = fixture();
    const sibling = fixture(first.engine);
    setSceneRenderSettings(first.scene, { renderPath: "clusteredForward" });
    setSceneRenderSettings(sibling.scene, { renderPath: "clusteredForward" });
    const other = container(sibling.scene)!;
    first.lights[0]!.dispose();
    const added = new PointLight("added", Vector3.Zero(), first.scene);
    applyAuthoredLightProperties(added, {
      enabled: true,
      castShadows: false,
      range: 20,
    });
    syncSceneLighting(first.scene);
    expect(container(first.scene)?.lights).toContain(added);
    expect(container(first.scene)?.lights).not.toContain(first.lights[0]);
    first.scene.dispose();
    expect(container(sibling.scene)).toBe(other);
    expect(other.lights).toEqual(sibling.lights);
  });

  it("admits a real lowered surface and owned unlit grid while rejecting an unregistered graph", async () => {
    const { scene, mesh } = fixture();
    const grid = createEditorGrid(scene);
    const lowered = lowerMaterialDocument(
      createDefaultMaterialDocument("surface"),
    );
    if (!lowered.ok) throw new Error("Fixture did not lower");
    const compiled = compileMaterialPlan(lowered.plan, {
      scene,
      name: "compiled",
    });
    if (!compiled.ok) throw new Error("Fixture did not compile");
    await compiled.ready;
    mesh.material = compiled.material;
    setSceneRenderSettings(scene, { renderPath: "clusteredForward" });
    expect(sceneRenderPathStatus(scene).effective.renderPath).toBe(
      "clusteredForward",
    );
    expect(container(scene)).toBeDefined();
    // Copying graph blocks is not the compiler's successful-build provenance.
    const copy = compiled.material.clone("external graph");
    if (!copy) throw new Error("Fixture did not clone");
    mesh.material = copy;
    syncSceneLighting(scene);
    expect(sceneRenderPathStatus(scene).effective.renderPath).toBe("forward");
    expect(sceneRenderPathStatus(scene).limits[0]).toContain("external graph");
    grid.dispose();
    compiled.dispose();
    copy.dispose();
  });

  it("applies a game-wide session request and resumes the project path on reset", () => {
    const { engine, scene } = fixture();
    setSceneRenderSettings(scene, { renderPath: "clusteredForward" });
    expect(requestRenderPath(engine, { renderPath: "forward" })).toBe(true);
    expect(container(scene)).toBeUndefined();
    expect(sceneRenderPathStatus(scene).requested.renderPath).toBe("forward");
    expect(requestRenderPath(engine, { renderPath: "forward" })).toBe(false);
    expect(requestRenderPath(engine, {})).toBe(true);
    expect(container(scene)).toBeDefined();
    expect(sceneRenderPathStatus(scene).requested.renderPath).toBe(
      "clusteredForward",
    );
  });
});
