import {
  DirectionalLight,
  MeshBuilder,
  NullEngine,
  Scene,
  TransformNode,
  UniversalCamera,
  Vector3,
} from "@babylonjs/core";
import { normalizeShadowSettings } from "@babylonslate/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateSceneRenderingSettings } from "./render-settings";
import { findSceneShadowController, sceneShadowController } from "./shadow-controller";
import { captureShadowDiagnostics } from "./shadow-diagnostics";

const engines: NullEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

function fixture() {
  const engine = new NullEngine();
  engines.push(engine);
  Object.assign(engine.getCaps(), {
    maxTexturesImageUnits: 16,
    maxTextureSize: 256,
    maxCubemapTextureSize: 256,
    textureHalfFloatRender: true,
    textureHalfFloatLinearFiltering: true,
  });
  const scene = new Scene(engine);
  scene.activeCamera = new UniversalCamera("camera", new Vector3(0, 2, -10), scene);
  return scene;
}

describe("opt-in shadow evidence capture", () => {
  it("records admitted dimensions and current projection without changing the authored request or redrawing", () => {
    const scene = fixture();
    updateSceneRenderingSettings(scene, {
      gpuBackend: "webgpu",
      shadows: normalizeShadowSettings({
        mapSize: 1024, cascades: 1, distance: 10,
        autoBias: false, depthBias: 0.002, normalBias: 0.007,
      }),
    });
    const parent = new TransformNode("light-parent", scene);
    parent.position.set(3, 4, 5);
    const light = new DirectionalLight("sun", new Vector3(0, -1, 1), scene);
    light.parent = parent;
    light.position.set(1, 2, 3);
    const controller = sceneShadowController(scene);
    controller.register(light, true);
    controller.sync();
    const generator = controller.generator(light)!;
    generator.getTransformMatrix();
    const updateProjection = vi.spyOn(generator, "getTransformMatrix");
    const renderMap = vi.spyOn(generator.getShadowMap()!, "render");

    const evidence = captureShadowDiagnostics(scene, {
      buildSha: "revision", host: "unit-test", backendFallbackReason: "No native GPU in this test",
    });

    expect(evidence.backend).toMatchObject({ requested: "webgpu", actual: "null" });
    expect(evidence.requestedShadows).toMatchObject({ mapSize: 1024, cascades: 1 });
    expect(evidence.lights[0]).toMatchObject({
      requested: true,
      allocationDownsized: true,
      worldPosition: [4, 6, 8],
      generator: {
        map: { width: 256, height: 256, cube: false },
        autoBias: false,
        currentBias: { depth: 0.002, normalWorld: 0.007 },
      },
    });
    const footprint = evidence.lights[0]!.generator!.projections[0]!.orthographicExtents!;
    expect(footprint.width).toBeCloseTo(20);
    expect(footprint.height).toBeCloseTo(20);
    expect(footprint.depth).toBeCloseTo(20);
    expect(updateProjection).not.toHaveBeenCalled();
    expect(renderMap).not.toHaveBeenCalled();
    // Captured evidence must remain attached to its original settings/draw.
    generator.bias = 0.01;
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ mapSize: 512 }) });
    expect(evidence.lights[0]!.generator!.currentBias.depth).toBe(0.002);
    expect(evidence.requestedShadows.mapSize).toBe(1024);
  });

  it("bounds selected geometry and lights without installing a lifecycle owner", () => {
    const scene = fixture();
    new DirectionalLight("captured", Vector3.Down(), scene);
    new DirectionalLight("omitted", Vector3.Down(), scene);
    const captured = MeshBuilder.CreateBox("captured", { size: 2 }, scene);
    captured.position.set(2, 0, 0);
    captured.computeWorldMatrix(true);
    const omitted = MeshBuilder.CreateBox("omitted", { size: 1 }, scene);
    const omittedBounds = vi.spyOn(omitted, "getBoundingInfo");
    const evidence = captureShadowDiagnostics(scene, {
      meshes: [captured, omitted], maxLights: 1, maxMeshes: 1,
    });

    expect(findSceneShadowController(scene)).toBeUndefined();
    expect(evidence.truncated).toEqual({ lights: 1, meshes: 1 });
    expect(evidence.models).toEqual([
      expect.objectContaining({ worldBounds: { min: [1, -1, -1], max: [3, 1, 1] } }),
    ]);
    expect(omittedBounds).not.toHaveBeenCalled();
    expect(evidence.lights[0]!.generator).toBeNull();
    expect(evidence.provenance).toMatchObject({ buildSha: null, host: null, os: null, sceneUnits: null });
    expect(JSON.parse(JSON.stringify(evidence))).toEqual(evidence);
  });
});
