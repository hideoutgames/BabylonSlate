import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Camera,
  FreeCamera,
  DirectionalLight,
  HemisphericLight,
  TransformNode,
  MeshBuilder,
  NullEngine,
  PBRMaterial,
  PointLight,
  Scene,
  SpotLight,
  StandardMaterial,
  Vector3,
  type AbstractMesh,
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
import {
  normalizeRenderingQuality,
  normalizeShadowSettings,
} from "@babylonslate/core";
import { syncSceneLighting } from "./scene-lighting";
import { ForwardSceneFrameGraph } from "./framegraph-forward-scene";
import {
  createDefaultMaterialDocument,
  lowerMaterialDocument,
} from "@babylonslate/shader-graph";
import { compileMaterialPlan } from "./material-compiler";
import { isSceneFrameReady } from "./scene-perf";

import {
  limitManagedLightingBytes,
  managedLightingReservations,
} from "./managed-lighting-resources";

const engines: NullEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
  vi.restoreAllMocks();
});

function fixture(engine = new NullEngine()) {
  if (!engines.includes(engine)) {
    engines.push(engine);
    // NullEngine reports WebGL1; expose the proven WebGL2 capability boundary
    // without replacing the real container or its membership implementation.
    vi.spyOn(engine, "version", "get").mockReturnValue(2);
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
    // Native NullEngine raw uploads retain data but never mark it ready. Supply
    // that absent GPU completion boundary so real material/graph probes can run.
    const createRawTexture = engine.createRawTexture.bind(engine);
    vi.spyOn(engine, "createRawTexture").mockImplementation((...args) => {
      const texture = createRawTexture(...args);
      texture.isReady = true;
      return texture;
    });
    // Like the shadow-controller fixture, complete NullEngine's missing cube
    // wrapper attachment so repeated real admission sees the allocated map size.
    const createCubeTarget = engine.createRenderTargetCubeTexture.bind(engine);
    vi.spyOn(engine, "createRenderTargetCubeTexture").mockImplementation(
      (...args) => {
        const target = createCubeTarget(...args);
        if (!target.texture) {
          const texture = engine.getLoadedTexturesCache().at(-1);
          if (!texture)
            throw new Error("NullEngine cube allocation has no texture");
          target.setTexture(texture);
        }
        return target;
      },
    );
    // Pinned NullEngine omits the requested RTT format, unlike real WebGL.
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
  updateSceneRenderingSettings(scene, {
    quality: normalizeRenderingQuality({
      lighting: { localLightMode: "manual", maxLocalLights: 256 },
    }),
  });
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
  it("cleans up an actual texture layout larger than its pre-allocation reservation before publishing a container", () => {
    const { engine, scene, lights } = fixture();
    const before = scene.textures.slice();
    const wrappers = engine._renderTargetWrapperCache.slice();
    const allocate = vi
      .mocked(engine.createRenderTargetTexture)
      .getMockImplementation()!;
    vi.spyOn(engine, "createRenderTargetTexture").mockImplementationOnce(
      (...args) => {
        const target = allocate(...args);
        target.texture!.format = 5; // RGBA instead of the declared single-channel R32F mask.
        return target;
      },
    );
    const owner = new ClusteredSceneLights(scene, lights);
    expect(owner.status().clustered).toBe(0);
    expect(owner.status().fallbackReason).toContain("reserved peak");
    expect(scene.textures).toEqual(before);
    expect(engine._renderTargetWrapperCache).toEqual(wrappers);
    expect(managedLightingReservations(engine).reservedBytes).toBe(0);
    expect(
      lights.every(
        (light) =>
          scene.lights.includes(light) && isAuthoredLightEnabled(light),
      ),
    ).toBe(true);
    owner.dispose();
  });

  it("starves a sibling before construction and admits it after the exact owner's lease is released", () => {
    const first = fixture();
    limitManagedLightingBytes(first.engine, 18224);
    const owner = new ClusteredSceneLights(
      first.scene,
      first.lights.slice(0, 2),
    );
    expect(owner.status().clustered).toBe(2);
    const sibling = fixture(first.engine);
    const before = first.engine._renderTargetWrapperCache.slice();
    const waiting = new ClusteredSceneLights(
      sibling.scene,
      sibling.lights.slice(0, 2),
    );
    expect(waiting.status().clustered).toBe(0);
    expect(waiting.status().fallbackReason).toContain(
      "Shared managed lighting memory",
    );
    expect(first.engine._renderTargetWrapperCache).toEqual(before);
    expect(sibling.lights.every(isAuthoredLightEnabled)).toBe(true);
    owner.dispose();
    waiting.sync();
    expect(waiting.status().clustered).toBe(2);
    expect(managedLightingReservations(first.engine).reservedBytes).toBe(18224);
    waiting.dispose();
    expect(managedLightingReservations(first.engine).reservedBytes).toBe(0);
  });

  it("reserves replacement peaks and retains high-water bytes on shrink without reallocating settled frames", () => {
    const { engine, scene, lights } = fixture();
    limitManagedLightingBytes(engine, 72896);
    const owner = new ClusteredSceneLights(scene, lights.slice(0, 2));
    const original = owner.target(scene.activeCamera!);
    let peak = 0;
    const allocate = vi
      .mocked(engine.createRenderTargetTexture)
      .getMockImplementation()!;
    vi.spyOn(engine, "createRenderTargetTexture").mockImplementation(
      (...args) => {
        peak = managedLightingReservations(engine).reservedBytes;
        return allocate(...args);
      },
    );
    owner.setLights(lights);
    expect(peak).toBe(72896);
    expect(owner.status().clustered).toBe(48);
    expect(owner.status().estimatedBytes).toBe(54672);
    expect(owner.target(scene.activeCamera!)).not.toBe(original);
    const grown = owner.target(scene.activeCamera!);
    owner.setLights(lights.slice(0, 2));
    for (let i = 0; i < 3; i++) {
      owner.sync();
      owner.target(scene.activeCamera!);
    }
    expect(owner.target(scene.activeCamera!)).toBe(grown);
    expect(managedLightingReservations(engine)).toMatchObject({
      clusterBytes: 54672,
      pendingBytes: 0,
    });
    owner.setLights([]);
    expect(managedLightingReservations(engine).reservedBytes).toBe(0);
  });

  it("preserves same-scene shadow reservations while clusters contend and recover after context restoration", () => {
    const { engine, scene, lights } = fixture();
    const key = new SpotLight(
      "key",
      new Vector3(0, 3, 0),
      Vector3.Down(),
      Math.PI / 2,
      1,
      scene,
    );
    applyAuthoredLightProperties(key, {
      enabled: true,
      castShadows: true,
      range: 12,
    });
    updateSceneRenderingSettings(scene, {
      quality: normalizeRenderingQuality({
        lighting: { localLightMode: "manual", maxLocalLights: 256 },
      }),
      shadows: normalizeShadowSettings({
        localLightMode: "manual",
        maxLocalLights: 1,
        localMapSize: 256,
      }),
    });
    const shadows = sceneShadowController(scene);
    shadows.sync();
    const shadowBytes = managedLightingReservations(engine).shadowBytes;
    expect(shadowBytes).toBeGreaterThan(0);
    const generator = shadows.generator(key);
    limitManagedLightingBytes(engine, shadowBytes + 18224);
    const owner = new ClusteredSceneLights(scene, lights);
    expect(owner.status().clustered).toBe(23);
    expect(owner.limits().join()).toContain("Shared managed lighting memory");
    shadows.sync();
    expect(shadows.generator(key)).toBe(generator);
    expect(managedLightingReservations(engine).reservedBytes).toBe(
      shadowBytes + 18224,
    );
    engine.onContextRestoredObservable.notifyObservers(engine);
    expect(managedLightingReservations(engine).reservedBytes).toBe(0);
    shadows.sync();
    owner.sync();
    expect(owner.status().clustered).toBe(23);
    expect(shadows.generator(key)).not.toBeNull();
    expect(managedLightingReservations(engine).reservedBytes).toBe(
      shadowBytes + 18224,
    );
    scene.dispose();
    expect(managedLightingReservations(engine).reservedBytes).toBe(0);
  });

  it("does not re-admit the removed cluster proxy when Babylon delivers its deferred mesh-added notification", async () => {
    const { scene, lights } = fixture();
    applyAuthoredLightProperties(lights[0]!, {
      enabled: true,
      castShadows: true,
      range: 12,
    });
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({
        localLightMode: "manual",
        maxLocalLights: 1,
        localMapSize: 64,
      }),
    });
    const controller = sceneShadowController(scene);
    let proxy: AbstractMesh | undefined;
    scene.onNewMeshAddedObservable.add((mesh) => {
      if (mesh.name === "ProxyMesh") proxy = mesh;
    });
    const owner = new ClusteredSceneLights(scene, lights);
    await vi.waitFor(() => expect(proxy).toBeDefined());
    controller.sync();
    expect(scene.meshes).not.toContain(proxy);
    const generator = controller.generator(lights[0]!);
    expect(generator).not.toBeNull();
    const shadow = generator!.getShadowMap()!;
    expect(shadow.renderList).not.toContain(proxy);
    // The real thin-instance ShaderMaterial proxy must not force otherwise
    // static local maps into continuous refresh.
    expect(shadow.refreshRate).toBe(0);
    owner.dispose();
  });

  it("keeps CEL Strongest interleaving conventional until an authored priority change creates a contiguous tail", () => {
    const { scene, mesh, lights } = fixture();
    for (const light of lights.slice(3)) light.dispose();
    const authored = lights.slice(0, 3);
    updateSceneRenderingSettings(scene, { mode: "cel" });
    authored[1]!.falloffType = PointLight.FALLOFF_GLTF;
    const owner = new ClusteredSceneLights(scene, authored);
    expect(owner.status().clustered).toBe(0);
    expect(owner.limits().join()).toContain("authored interleaving");
    expect(scene.requireLightSorting).toBe(false);
    expect(mesh.lightSources).toEqual(authored);
    for (const x of [-20, 20]) {
      (scene.activeCamera as FreeCamera).position.x = x;
      syncSceneLighting(scene);
      expect(owner.target(scene.activeCamera!)).toBeUndefined();
      expect(mesh.lightSources).toEqual(authored);
    }
    // Explicit priority is a controlled layout reconfiguration. The unsupported
    // middle light becomes the conventional prefix; the two children follow.
    authored[1]!.renderPriority = 1;
    syncSceneLighting(scene);
    expect(owner.status().clustered).toBe(2);
    expect(owner.limits()).toEqual([]);
    expect(mesh.lightSources[0]).toBe(authored[1]);
    expect(mesh.lightSources[1]).toBeInstanceOf(ClusteredLightContainer);
    owner.dispose();
    expect(mesh.lightSources).toEqual([authored[1], authored[0], authored[2]]);
    expect(authored.every(isAuthoredLightEnabled)).toBe(true);
  });

  it("keeps requested shadows conventional through map admission changes without rebuilding the CEL tail", () => {
    const { scene, mesh, lights } = fixture();
    for (const light of lights.slice(3)) light.dispose();
    const authored = lights.slice(0, 3);
    applyAuthoredLightProperties(authored[0]!, {
      enabled: true,
      castShadows: true,
      range: 12,
    });
    const settings = (enabled: boolean, count: number) =>
      updateSceneRenderingSettings(scene, {
        mode: "cel",
        shadows: normalizeShadowSettings({
          enabled,
          localLightMode: "manual",
          maxLocalLights: count,
          localMapSize: 64,
        }),
      });
    settings(true, 0);
    const controller = sceneShadowController(scene);
    const owner = new ClusteredSceneLights(scene, authored);
    const map = owner.target(scene.activeCamera!)!;
    expect(owner.status().clustered).toBe(2);
    expect(controller.requestsShadow(authored[0]!)).toBe(true);
    expect(controller.generator(authored[0]!)).toBeNull();
    expect(scene.requireLightSorting).toBe(false);
    for (const [enabled, count] of [
      [true, 1],
      [false, 1],
      [true, 0],
    ] as const) {
      settings(enabled, count);
      (scene.activeCamera as FreeCamera).position.x += 1;
      syncSceneLighting(scene);
      expect(Boolean(controller.generator(authored[0]!))).toBe(
        enabled && count > 0,
      );
      expect(controller.requestsShadow(authored[0]!)).toBe(true);
      expect(owner.status().clustered).toBe(2);
      expect(owner.target(scene.activeCamera!)).toBe(map);
      expect(mesh.lightSources[0]).toBe(authored[0]);
      expect(
        mesh.lightSources.filter((light) => light === authored[0]),
      ).toHaveLength(1);
    }
    // Turning off the authored request, unlike changing admission, reconfigures
    // the tail and still contributes this light exactly once.
    applyAuthoredLightProperties(authored[0]!, {
      enabled: true,
      castShadows: false,
      range: 12,
    });
    syncSceneLighting(scene);
    expect(controller.requestsShadow(authored[0]!)).toBe(false);
    expect(owner.status().clustered).toBe(3);
    expect(mesh.lightSources).toHaveLength(1);
    owner.dispose();
    expect(mesh.lightSources).toEqual(authored);
    expect(scene.requireLightSorting).toBe(false);
  });

  it("borrows 48 enabled children once and returns disabled children without changing authored light values", () => {
    const { scene, mesh, lights } = fixture();
    const owner = new ClusteredSceneLights(scene, lights);
    const container = scene.lights.find(
      (light) => light instanceof ClusteredLightContainer,
    ) as ClusteredLightContainer;
    expect(owner.status().clustered).toBe(48);
    const allocatedBytes = owner.status().estimatedBytes;
    expect(scene.lights).toEqual([container]);
    expect(mesh.lightSources).toEqual([container]);
    expect(lights[0]!.range).toBe(12);
    expect(lights[0]!.intensity).toBe(2);
    expect(lights[0]!.diffuse.asArray()).toEqual([0.2, 0.6, 0.8]);
    setAuthoredLightEnabled(lights[0]!, false);
    lights[1]!.intensity = 0;
    syncSceneLighting(scene);
    expect(owner.status().clustered).toBe(46);
    expect(owner.status().estimatedBytes).toBe(allocatedBytes);
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

  it("shares one quality allowance across clustered children and admitted shadows while preserving sun and authored state", () => {
    const { scene, mesh, lights } = fixture();
    for (const light of lights.slice(6)) setAuthoredLightEnabled(light, false);
    const sun = new DirectionalLight("sun", Vector3.Down(), scene);
    applyAuthoredLightProperties(sun, { enabled: true, castShadows: false });
    const spot = new SpotLight(
      "shadowed",
      new Vector3(0, 3, 0),
      Vector3.Down(),
      Math.PI / 2,
      1,
      scene,
    );
    spot.renderPriority = 2;
    const settings = (manual?: number) =>
      updateSceneRenderingSettings(scene, {
        quality: normalizeRenderingQuality({
          lighting: {
            profile: "low",
            localLightMode: manual === undefined ? "auto" : "manual",
            maxLocalLights: manual ?? 4,
          },
        }),
        shadows: normalizeShadowSettings({
          enabled: true,
          localMapSize: 64,
          localLightMode: "manual",
          maxLocalLights: 1,
        }),
      });
    settings();
    applyAuthoredLightProperties(spot, {
      enabled: true,
      castShadows: true,
      range: 12,
    });
    const locals = [...lights.slice(0, 6), spot];
    const owner = new ClusteredSceneLights(scene, locals);
    const controller = sceneShadowController(scene);
    expect(controller.generator(spot)).not.toBeNull();
    expect(owner.status().clustered).toBe(3);
    expect(locals.filter((light) => light.isEnabled())).toHaveLength(4);
    expect(sun.isEnabled()).toBe(true);
    expect(mesh.lightSources.filter((light) => light === spot)).toHaveLength(1);
    expect(lights.slice(0, 6).every(isAuthoredLightEnabled)).toBe(true);
    expect(owner.limits().join()).toContain("quality budget");

    // Manual overrides the Low Auto target, but it remains one total allowance.
    settings(5);
    syncSceneLighting(scene);
    expect(owner.status().clustered).toBe(4);
    expect(locals.filter((light) => light.isEnabled())).toHaveLength(5);
    expect(sun.isEnabled()).toBe(true);
    settings(2);
    syncSceneLighting(scene);
    expect(owner.status().clustered).toBe(1);
    expect(locals.filter((light) => light.isEnabled())).toHaveLength(2);

    const parent = new TransformNode("moved excluded parent", scene);
    const moved = lights[5]!;
    moved.parent = parent;
    parent.position.set(-moved.position.x, 1, -5);
    syncSceneLighting(scene);
    expect(moved.isEnabled()).toBe(true);
    expect(lights[0]!.isEnabled()).toBe(false);
    expect(locals.filter((light) => light.isEnabled())).toHaveLength(2);
    expect(controller.generator(spot)).not.toBeNull();

    settings(0);
    syncSceneLighting(scene);
    expect(owner.status().clustered).toBe(0);
    expect(locals.some((light) => light.isEnabled())).toBe(false);
    expect(sun.isEnabled()).toBe(true);
    expect(locals.every(isAuthoredLightEnabled)).toBe(true);
    owner.dispose();
    const late = new PointLight("after disposal", Vector3.Zero(), scene);
    const observers = late.onDisposeObservable.observers.length;
    owner.setLights([late]);
    expect(late.onDisposeObservable.observers).toHaveLength(observers);
    expect(scene.lights).toContain(late);
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

  it("retains physical PBR range while selecting conservative camera bounds", () => {
    const { scene, mesh, lights } = fixture();
    mesh.material = new PBRMaterial("physical", scene);
    const owner = new ClusteredSceneLights(scene, lights);
    expect(owner.status().clustered).toBe(48);
    expect(owner.limits().join()).toContain("unbounded attenuation");
    expect(scene.lights).toHaveLength(1);
    expect(lights.every((light) => light.isEnabled())).toBe(true);
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
  it("does not borrow children when global lights exhaust the shader slots", () => {
    const { scene, lights } = fixture();
    for (let index = 0; index < 4; index++)
      new HemisphericLight(`fill-${index}`, Vector3.Up(), scene);
    const owner = new ClusteredSceneLights(scene, lights);
    expect(owner.status().clustered).toBe(0);
    expect(owner.limits().join()).toContain("No conventional shader slot");
    expect(lights.every((light) => scene.lights.includes(light))).toBe(true);
    owner.dispose();
  });

  it("refreshes parented world positions before packing a moved clustered child", () => {
    const { scene, lights } = fixture();
    const parent = new TransformNode("parent", scene);
    lights[0]!.parent = parent;
    const owner = new ClusteredSceneLights(scene, lights);
    parent.position.x = 20;
    owner.target(scene.activeCamera!);
    expect(lights[0]!.getAbsolutePosition().x).toBeCloseTo(20);
    owner.dispose();
  });

  it("orders one borrowed mask draw after readiness and leaves it live when the graph is disposed", async () => {
    const { engine, scene, mesh, lights } = fixture();
    vi.spyOn(engine, "buildTextureLayout").mockImplementation(
      (enabled, backbuffer) =>
        backbuffer
          ? [0x0405]
          : enabled.map((value, index) => (value ? 0x8ce0 + index : 0)),
    );
    vi.spyOn(engine, "bindAttachments").mockImplementation(() => {});
    vi.spyOn(engine, "restoreSingleAttachment").mockImplementation(() => {});
    vi.spyOn(
      engine,
      "restoreSingleAttachmentForRenderTarget",
    ).mockImplementation(() => {});
    const owner = new ClusteredSceneLights(scene, lights);
    const target = owner.target(scene.activeCamera!)!;
    const texture = target.getInternalTexture();
    const draw = vi.spyOn(target, "render");
    const graph = new ForwardSceneFrameGraph(scene);
    expect(await graph.prepare(scene.activeCamera!)).toEqual({
      path: "frameGraph",
    });
    expect(draw).not.toHaveBeenCalled();
    // A new/resized WebGL framebuffer can invalidate the cached alpha mode.
    // The ordered mask must not turn that sentinel into additive surface draws.
    engine._resetAlphaMode();
    engine.alphaState.reset();
    const surfaceBlendStates: boolean[] = [];
    mesh.onBeforeDrawObservable.add(() =>
      surfaceBlendStates.push(engine.alphaState.alphaBlend),
    );
    expect(graph.render(scene.activeCamera!)).toEqual({ path: "frameGraph" });
    expect(surfaceBlendStates).toEqual([false]);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(graph.render(scene.activeCamera!)).toEqual({ path: "frameGraph" });
    expect(draw).toHaveBeenCalledTimes(2);
    graph.dispose();
    expect(owner.target(scene.activeCamera!)).toBe(target);
    expect(target.getInternalTexture()).toBe(texture);
    expect(owner.status().clustered).toBe(48);
    owner.dispose();
    expect(scene.textures).not.toContain(target);
  });
  it("registers cluster defines and samplers when an already compiled point-light slot changes type", async () => {
    const { engine, scene, mesh, lights } = fixture();
    for (const light of lights.slice(1)) setAuthoredLightEnabled(light, false);
    // NullEngine discards all unresolved GPU uniform locations, so inspect the
    // actual createEffect binding request before native effect finalization.
    const samplerRequests: string[][] = [];
    const createEffect = engine.createEffect.bind(engine);
    vi.spyOn(engine, "createEffect").mockImplementation((...args) => {
      const options = args[1];
      if (!Array.isArray(options)) samplerRequests.push([...options.samplers]);
      return createEffect(...args);
    });
    const lower = lowerMaterialDocument(
      createDefaultMaterialDocument("surface"),
    );
    if (!lower.ok) throw new Error("Fixture did not lower");
    const compiled = compileMaterialPlan(lower.plan, {
      scene,
      name: "surface",
    });
    if (!compiled.ok) throw new Error("Fixture did not compile");
    await compiled.ready;
    mesh.material = compiled.material;
    engine.currentRenderPassId = scene.activeCamera!.renderPassId;
    syncSceneLighting(scene);
    await vi.waitFor(() => expect(isSceneFrameReady(scene)).toBe(true));
    const previous = mesh.subMeshes[0]!.effect!;
    expect(samplerRequests.flat()).not.toContain("tileMaskTexture0");
    samplerRequests.length = 0;
    const owner = new ClusteredSceneLights(scene, lights);
    await vi.waitFor(() => expect(isSceneFrameReady(scene)).toBe(true));
    const clustered = mesh.subMeshes[0]!.effect!;
    expect(clustered).not.toBe(previous);
    expect(clustered.defines).toMatch(/#define CLUSTLIGHT_SLICES [1-9]/);
    expect(clustered.defines).toContain("#define CLUSTLIGHT_BATCH 23");
    expect(samplerRequests.flat()).toEqual(
      expect.arrayContaining(["lightDataTexture0", "tileMaskTexture0"]),
    );
    owner.dispose();
    syncSceneLighting(scene);
    await vi.waitFor(() => expect(isSceneFrameReady(scene)).toBe(true));
    expect(mesh.lightSources).toEqual([lights[0]]);
  });

  it("uploads stable authored light rows when camera depth reverses, and honors explicit priority changes", () => {
    const { engine, scene, lights } = fixture();
    for (const light of lights.slice(2)) light.dispose();
    lights[0]!.position.set(-2, 3, 0);
    lights[1]!.position.set(2, 3, 0);
    const owner = new ClusteredSceneLights(scene, lights.slice(0, 2));
    const camera = scene.activeCamera as FreeCamera;
    const target = owner.target(camera)!;
    const uploads = vi.spyOn(engine, "updateRawTexture");
    const rows = () => {
      const upload = uploads.mock.calls
        .filter(
          (call) => call[1] instanceof Float32Array && call[1].length >= 40,
        )
        .at(-1);
      const data = upload![1] as Float32Array;
      return [data[0], data[20]];
    };
    for (const x of [-3, 3]) {
      camera.position.set(x, 3, -6);
      camera.setTarget(Vector3.Zero());
      scene.incrementRenderId();
      target.render(false);
      expect(rows()).toEqual([-2, 2]);
      expect(owner.target(camera)).toBe(target);
    }
    lights[1]!.renderPriority = 1;
    scene.incrementRenderId();
    target.render(false);
    expect(rows()).toEqual([2, -2]);
    owner.dispose();
    expect(lights.slice(0, 2).every((light) => !light.isDisposed())).toBe(true);
  });

  it("returns conventional lighting for orthographic cameras pending a compatible mask projection", () => {
    const { scene, lights } = fixture();
    scene.activeCamera!.mode = Camera.ORTHOGRAPHIC_CAMERA;
    const owner = new ClusteredSceneLights(scene, lights);
    expect(owner.status().clustered).toBe(0);
    expect(owner.limits().join()).toContain("perspective camera");
    owner.dispose();
  });

  it("releases departed registry observers and rolls back a failing larger batch allocation", async () => {
    const { engine, scene, lights } = fixture();
    const observerCount = lights[1]!.onDisposeObservable.observers.length;
    const wrappers = engine._renderTargetWrapperCache.slice();
    const owner = new ClusteredSceneLights(scene, lights.slice(0, 2));
    owner.setLights(lights.slice(0, 1));
    // Observable.remove marks synchronously and removes its entry next task.
    await vi.waitFor(() =>
      expect(lights[1]!.onDisposeObservable.observers).toHaveLength(
        observerCount,
      ),
    );
    const createTarget = engine.createRenderTargetTexture.bind(engine);
    vi.spyOn(engine, "createRenderTargetTexture").mockImplementationOnce(
      (...args) => {
        createTarget(...args);
        throw new Error("Larger mask allocation rejected");
      },
    );
    owner.setLights(lights);
    expect(owner.status().clustered).toBe(0);
    expect(owner.limits().join()).toContain("Larger mask allocation rejected");
    expect(managedLightingReservations(engine).reservedBytes).toBe(0);
    expect(engine._renderTargetWrapperCache).toEqual(wrappers);
    expect(
      scene.textures.some((texture) => texture.name === "TileMaskTexture"),
    ).toBe(false);
    expect(
      lights.every(
        (light) => !light.isDisposed() && scene.lights.includes(light),
      ),
    ).toBe(true);
    owner.dispose();
  });
});
