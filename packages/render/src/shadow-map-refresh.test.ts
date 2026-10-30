import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CascadedShadowGenerator,
  DirectionalLight,
  Material,
  Matrix,
  Mesh,
  MeshBuilder,
  MorphTargetManager,
  NullEngine,
  NullEngineOptions,
  PointLight,
  Scene,
  Skeleton,
  StandardMaterial,
  TransformNode,
  SubMesh,
  UniversalCamera,
  Vector3,
  VertexBuffer,
  VertexData,
} from "@babylonjs/core";
import { DynamicRuntimeMeshGeometry, normalizeShadowSettings, SHADOW_FAR_CASTER_MIN_TEXELS } from "@haptic/core";
import { applyDynamicRuntimeMeshUpdate, createDynamicRuntimeMesh } from "./dynamic-runtime-mesh";
import { sceneShadowController } from "./shadow-controller";
import { attachModelLods, generateModelLods } from "./model-lod";
import { updateSceneRenderingSettings } from "./render-settings";
import { applyCableFrame, createCableMesh } from "./cable-mesh";
import { createLandscapeMesh, updateLandscapeMesh } from "./landscape-mesh";
import { ShadowMapRefresh } from "./shadow-map-refresh";
import type { AtlasCascadedShadowGenerator } from "./shadow-atlas";
import { HAPTIC_SHADOW_VIEW_VEC4S, hapticLightBuffer, hapticShadowViews, writeHapticLights } from "./haptic-lights";
import type { AtlasShadow } from "./shadow-atlas";

const engines: NullEngine[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) engine.dispose();
});

async function fixture(floatingOrigin = false) {
  const options = new NullEngineOptions();
  options.enableMultiview = floatingOrigin;
  const engine = new NullEngine(options);
  engines.push(engine);
  // A shipped Engine's texture limit holds the point light's six faces as atlas tiles.
  Object.assign(engine.getCaps(), { maxTexturesImageUnits: 16, maxTextureSize: 4096 });
  const scene = new Scene(engine, { useFloatingOrigin: floatingOrigin });
  const camera = new UniversalCamera("camera", new Vector3(0, 2, -10), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  updateSceneRenderingSettings(scene, {
    shadows: normalizeShadowSettings({
      cascades: 1,
      localMapSize: 256,
      maxLocalLights: 1,
    }),
  });
  const added = new Promise<void>((resolve) =>
    scene.onNewMeshAddedObservable.addOnce(() => resolve()),
  );
  const mesh = MeshBuilder.CreateBox("caster", {}, scene);
  const material = new StandardMaterial("opaque", scene);
  mesh.material = material;
  mesh.freezeWorldMatrix();
  const previousGeometryUpdate = vi.fn();
  const geometry = mesh.geometry!;
  geometry.onGeometryUpdated = previousGeometryUpdate;
  const light = new PointLight("local", new Vector3(0, 3, 0), scene);
  const controller = sceneShadowController(scene);
  controller.register(light, true);
  await added;
  controller.sync();
  const generator = controller.generator(light)!;
  const map = generator.getShadowMap()!;
  // RTT readiness also emits per-face render observables. Count the map's real
  // framebuffer bindings instead, including the clears needed after the last
  // caster leaves; its tiles share the atlas framebuffer with other maps.
  const bindFrameBuffer = map._bindFrameBuffer.bind(map);
  const faces = vi.spyOn(map, "_bindFrameBuffer").mockImplementation((...args) => bindFrameBuffer(...args));
  await material.forceCompilationAsync(mesh);
  await generator.forceCompilationAsync();
  const render = () => {
    const previous = faces.mock.calls.length;
    scene.render();
    return faces.mock.calls.length - previous;
  };
  return {
    scene,
    camera,
    mesh,
    geometry,
    material,
    light,
    controller,
    generator,
    map,
    faces,
    render,
    previousGeometryUpdate,
  };
}

describe("local shadow refresh", () => {
  it("caches unchanged runtime mesh shadows and refreshes edits and clear in the same frame", async () => {
    const { scene, material, controller, render } = await fixture();
    const geometry = new DynamicRuntimeMeshGeometry();
    geometry.setGeometry([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
    const mesh = createDynamicRuntimeMesh(scene, "runtime", { meshId: 1, update: geometry.takeUpdate() });
    mesh.material = material;
    controller.setParticipation(mesh, { castShadows: true });
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    geometry.updateVertices(0, [0, 0, 1]);
    applyDynamicRuntimeMeshUpdate(scene, 1, geometry.takeUpdate());
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    geometry.clear();
    applyDynamicRuntimeMeshUpdate(scene, 1, geometry.takeUpdate());
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    mesh.dispose();
  });
  it("caches resting cable shadows and refreshes changed geometry in the same rendered frame", async () => {
    const { scene, material, controller, render } = await fixture();
    const cable = createCableMesh(scene, "cable", { numSegments: 2, numSides: 4 }, 1);
    cable.material = material;
    controller.setParticipation(cable, { castShadows: true });
    applyCableFrame(scene, new Float32Array([1, 3, -1, -1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 2, 1, 0]), 1);
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    applyCableFrame(scene, new Float32Array([1, 3, -1, -1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 1, 2, 0, 2, 2, 0]), 2);
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    cable.dispose();
    expect(render()).toBe(6);
    expect(render()).toBe(0);
  });
  it("accepts empty mesh roots and refreshes when their submeshes are populated or removed", async () => {
    const { scene, material, controller, map, render } = await fixture();
    expect(render()).toBe(6);
    expect(render()).toBe(0);

    const pending = new Mesh("pending model root", scene);
    pending.material = material;
    // This is Babylon's real initial state, not an incomplete mesh stub.
    expect(pending.subMeshes).toBeUndefined();
    controller.setParticipation(pending, { castShadows: true });
    expect(render()).toBe(6);
    // Neither geometry nor parts draws nothing; the geometry it later gets is tracked.
    expect(render()).toBe(0);

    VertexData.CreateBox({}).applyToMesh(pending);
    expect(render()).toBe(6);
    expect(map.renderList).toContain(pending);
    expect(render()).toBe(0);

    pending.releaseSubMeshes();
    expect(render()).toBe(6);
    expect(render()).toBe(0);
  });

  it("caches landscape chunks and refreshes once when sculpting rewrites their heights", async () => {
    const { scene, material, controller, render } = await fixture();
    const properties = { width: 4, depth: 4, subdivisions: 2, heights: Array.from({ length: 9 }, () => 0) };
    const root = createLandscapeMesh(scene, "land", properties);
    const chunks = root.getChildMeshes() as Mesh[];
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      // Its buffers are updatable, as sculpting rewrites them in place.
      expect(chunk.getVertexBuffer(VertexBuffer.PositionKind)!.isUpdatable()).toBe(true);
      chunk.material = material;
      controller.setParticipation(chunk, { castShadows: true });
    }
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    updateLandscapeMesh(root, { ...properties, heights: properties.heights.map((_, index) => (index === 4 ? 1 : 0)) });
    for (const chunk of chunks) chunk.material = material;
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    root.dispose();
  });

  it("caches static thin instances, refreshes for a new placement buffer, and keeps updatable ones live", async () => {
    const { scene, material, controller, render } = await fixture();
    const placements = (x: number) => Float32Array.from([...Matrix.Translation(x, 0, 0).m, ...Matrix.Translation(-x, 0, 0).m]);
    const plants = MeshBuilder.CreateBox("plants", {}, scene);
    plants.material = material;
    plants.thinInstanceSetBuffer("matrix", placements(1), 16, true);
    controller.setParticipation(plants, { castShadows: true });
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    plants.thinInstanceSetBuffer("matrix", placements(2), 16, true);
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    plants.thinInstanceCount = 1;
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    // An updatable buffer is rewritten in place without notice.
    plants.thinInstanceSetBuffer("matrix", placements(1), 16, false);
    expect([render(), render()]).toEqual([6, 6]);
    plants.dispose();
  });

  it("renders the first cube after readiness probes, then reuses unchanged content and allocation", async () => {
    const { scene, mesh, light, controller, generator, map, faces, render } =
      await fixture();
    expect(map.isReadyForRendering()).toBe(true);
    expect(map.isReadyForRendering()).toBe(true);
    expect(faces).not.toHaveBeenCalled();
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    mesh.freezeWorldMatrix(); // same pose with a newly computed matrix revision
    expect(render()).toBe(0);
    const parent = new TransformNode("light parent", scene);
    light.parent = parent;
    expect(render()).toBe(0);
    expect(render()).toBe(0);
    parent.position.x = 2;
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    expect(controller.generator(light)).toBe(generator);
  });

  it("invalidates visibility, material depth state, geometry edits and removed casters", async () => {
    const {
      scene,
      mesh,
      geometry,
      material,
      controller,
      generator,
      map,
      render,
      previousGeometryUpdate,
    } = await fixture();
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    mesh.isVisible = false;
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    mesh.isVisible = true;
    expect(render()).toBe(6);
    material.backFaceCulling = false;
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    const positions = [...mesh.getVerticesData(VertexBuffer.PositionKind)!];
    positions[0] = positions[0]! + 1;
    mesh.setVerticesData(VertexBuffer.PositionKind, positions, false);
    expect(previousGeometryUpdate).toHaveBeenCalled();
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    controller.setParticipation(mesh, { castShadows: false });
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    controller.setParticipation(mesh, { castShadows: true });
    expect(render()).toBe(6);
    mesh.dispose();
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    expect(generator.getShadowMap()).toBe(map);
    expect(geometry.onGeometryUpdated).toBe(previousGeometryUpdate);
    scene.dispose();
  });

  it("retries a map whose caster shader was not ready without another scene change", async () => {
    const { generator, render } = await fixture();
    vi.spyOn(generator, "isReady").mockReturnValueOnce(false);
    expect(render()).toBe(6);
    expect(render()).toBe(6);
    expect(render()).toBe(0);
  });

  it("walks the casters once per rendered frame and still sees edits made later in that frame", async () => {
    const { scene, mesh, render } = await fixture();
    const walk = vi.spyOn(ShadowMapRefresh.prototype, "syncCasters");
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    expect(walk).toHaveBeenCalledTimes(2);
    // Scripts and animations edit casters after the controller's before-render admission.
    scene.onBeforeRenderObservable.addOnce(() => {
      mesh.isVisible = false;
    });
    expect(render()).toBe(6);
    scene.onBeforeRenderObservable.addOnce(() => {
      mesh.isVisible = true;
    });
    expect(render()).toBe(6);
    expect(render()).toBe(0);
  });

  it("refreshes when mesh face orientation controls shadow culling", async () => {
    const { mesh, material, render } = await fixture();
    material.sideOrientation = null;
    mesh.sideOrientation = Material.CounterClockWiseSideOrientation;
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    mesh.sideOrientation = Material.ClockWiseSideOrientation;
    expect(render()).toBe(6);
    expect(render()).toBe(0);
  });

  it.each([false, true])(
    "keeps same-count dynamic index edits live (GPU-only: %s)",
    async (gpuMemoryOnly) => {
      const { mesh, geometry, render, previousGeometryUpdate } =
        await fixture();
      expect(render()).toBe(6);
      expect(render()).toBe(0);
      const indices = [...mesh.getIndices()!];
      mesh.setIndices(indices, null, true);
      expect(render()).toBe(6);
      previousGeometryUpdate.mockClear();
      [indices[0], indices[1]] = [indices[1]!, indices[0]!];
      geometry.updateIndices(indices, 0, gpuMemoryOnly);
      expect(previousGeometryUpdate).not.toHaveBeenCalled();
      expect(render()).toBe(6);
      [indices[0], indices[1]] = [indices[1]!, indices[0]!];
      geometry.updateIndices(indices, 0, gpuMemoryOnly);
      expect(render()).toBe(6);
    },
  );

  it("detects replaced and updated frozen attachment matrices without transform notifications", async () => {
    const { mesh, render } = await fixture();
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    const world = Matrix.Translation(1, 0, 0);
    mesh.freezeWorldMatrix(world);
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    Matrix.TranslationToRef(2, 0, 0, world);
    mesh.freezeWorldMatrix(world);
    expect(render()).toBe(6);
    expect(render()).toBe(0);
  });

  it.each([
    "skeleton",
    "morph",
    "alpha",
    "updatable",
    "unknown",
  ] as const)("keeps %s caster content refreshing", async (kind) => {
    const { scene, mesh, material, render } = await fixture();
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    switch (kind) {
      case "skeleton":
        mesh.skeleton = new Skeleton("rig", "rig", scene);
        break;
      case "morph":
        mesh.morphTargetManager = new MorphTargetManager(scene);
        break;
      case "alpha":
        material.transparencyMode = Material.MATERIAL_ALPHATEST;
        break;
      case "updatable":
        mesh.setVerticesData(
          VertexBuffer.PositionKind,
          mesh.getVerticesData(VertexBuffer.PositionKind)!,
          true,
        );
        break;
      case "unknown": {
        class UnknownMaterial extends StandardMaterial {}
        mesh.material = new UnknownMaterial("custom", scene);
        break;
      }
    }
    expect(render()).toBe(6);
    expect(render()).toBe(6);
  });

  it("caches an instance's shadow as its source's and refreshes when the instance or its source changes", async () => {
    const { mesh, material, render } = await fixture();
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    const instance = mesh.createInstance("instance");
    instance.position.set(1.5, 0, 0);
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    instance.position.x = 2.5;
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    instance.isVisible = false;
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    instance.isVisible = true;
    expect(render()).toBe(6);
    // Hidden, the source still gives the instance its geometry and depth state.
    mesh.isVisible = false;
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    const positions = [...mesh.getVerticesData(VertexBuffer.PositionKind)!];
    positions[0] = positions[0]! + 1;
    mesh.setVerticesData(VertexBuffer.PositionKind, positions, false);
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    material.backFaceCulling = false;
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    instance.dispose();
    expect(render()).toBe(6);
    expect(render()).toBe(0);
  });

  it("refreshes an instance for its source's geometry and depth state when the source itself casts nothing", async () => {
    // Only the instance's own record can report these: its source has none.
    const { mesh, material, controller, render } = await fixture();
    mesh.createInstance("instance").position.set(1.5, 0, 0);
    controller.setParticipation(mesh, { castShadows: false });
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    const positions = [...mesh.getVerticesData(VertexBuffer.PositionKind)!];
    positions[0] = positions[0]! + 1;
    mesh.setVerticesData(VertexBuffer.PositionKind, positions, false);
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    material.backFaceCulling = false;
    expect(render()).toBe(6);
    expect(render()).toBe(0);
  });

  it("draws an instance of a source with several parts where the instance is, not where its source is", async () => {
    // Babylon draws an instance in its source's part batches, which the map culls part by part; the source's parts lie
    // beyond the light's range, the instance within it.
    const { scene, mesh, light, controller, map, render } = await fixture();
    light.range = 6;
    mesh.unfreezeWorldMatrix();
    mesh.position.set(50, 0, 0);
    const vertices = mesh.getTotalVertices();
    mesh.subMeshes = [];
    new SubMesh(0, 0, vertices, 0, 18, mesh);
    new SubMesh(0, 0, vertices, 18, 18, mesh);
    controller.setParticipation(mesh, { castShadows: false });
    mesh.createInstance("instance").position.set(1.5, 0, 0);
    const engine = scene.getEngine();
    const draw = engine.drawElementsType.bind(engine);
    let drawn = 0;
    vi.spyOn(engine, "drawElementsType").mockImplementation((...args) => {
      if (engine._currentRenderTarget === map.renderTarget) drawn++;
      draw(...args);
    });
    expect(render()).toBe(6);
    expect(drawn).toBeGreaterThan(0);
  });

  it.each(["skeleton", "morph", "updatable", "levels of detail"] as const)(
    "keeps a hidden source's instance refreshing for its source's %s content",
    async (kind) => {
      const { scene, mesh, render } = await fixture();
      mesh.isVisible = false;
      mesh.createInstance("instance").position.set(1.5, 0, 0);
      expect(render()).toBe(6);
      expect(render()).toBe(0);
      switch (kind) {
        case "skeleton":
          mesh.skeleton = new Skeleton("rig", "rig", scene);
          break;
        case "morph":
          mesh.morphTargetManager = new MorphTargetManager(scene);
          break;
        case "updatable":
          mesh.setVerticesData(VertexBuffer.PositionKind, mesh.getVerticesData(VertexBuffer.PositionKind)!, true);
          break;
        case "levels of detail":
          mesh.addLODLevel(50, MeshBuilder.CreateBox("coarse", { size: 1 }, scene));
          break;
      }
      expect(render()).toBe(6);
      expect(render()).toBe(6);
    },
  );

  it("invalidates local depth changes while the sun's cascades follow the camera", async () => {
    const { scene, camera, light, controller, generator, render } =
      await fixture();
    const engine = scene.getEngine();
    // Every shipped Engine draws cascades: the sun's atlas map is one.
    engine._features.supportCSM = true;
    engine._features.supportShadowSamplers = true;
    const sun = new DirectionalLight("sun", new Vector3(0, -1, 1), scene);
    controller.register(sun, true);
    controller.sync();
    const sunlight = controller.generator(sun)!;
    expect(sunlight).toBeInstanceOf(CascadedShadowGenerator);
    await sunlight.forceCompilationAsync();
    const sunMap = sunlight.getShadowMap()!;
    const bindSun = sunMap._bindFrameBuffer.bind(sunMap);
    const sunDraw = vi.spyOn(sunMap, "_bindFrameBuffer").mockImplementation((...args) => bindSun(...args));
    const frame = () => {
      const before = sunDraw.mock.calls.length;
      return [render(), sunDraw.mock.calls.length - before];
    };
    expect(frame()).toEqual([6, 1]);
    expect(frame()).toEqual([0, 0]);
    // The point map's depth ends at the camera's far plane; the cascades refit to the new frustum.
    camera.maxZ = 250;
    expect(frame()).toEqual([6, 1]);
    expect(frame()).toEqual([0, 0]);
    // A camera move refits only the cascades.
    camera.position.x += 1;
    expect(frame()).toEqual([0, 1]);
    expect(frame()).toEqual([0, 0]);
    expect(controller.generator(light)).toBe(generator);
    expect(controller.generator(sun)).toBe(sunlight);
  });

  it("keeps caching automatic LOD casters and refreshes once when the drawn level changes", async () => {
    const { scene, camera, material, render } = await fixture();
    const source = MeshBuilder.CreateSphere("lod source", { segments: 32 }, scene);
    source.setEnabled(false);
    const actor = new TransformNode("actor", scene);
    const part = source.clone("lod caster", actor);
    part.setEnabled(true);
    part.material = material;
    expect(attachModelLods(actor, await generateModelLods({ meshes: [source] }))).toBe(1);
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    const near = scene.customLODSelector!(part, camera);
    camera.position.z -= 500;
    camera.getViewMatrix(true);
    expect(scene.customLODSelector!(part, camera)).not.toBe(near);
    expect(render()).toBe(6);
    expect(render()).toBe(0);
  });

  it("ignores level changes of automatic LOD casters outside a local light's range", async () => {
    const { scene, camera, light, material, render } = await fixture();
    light.range = 10;
    const source = MeshBuilder.CreateSphere("lod source", { segments: 32 }, scene);
    source.setEnabled(false);
    const actor = new TransformNode("actor", scene);
    actor.position.x = 15;
    const part = source.clone("distant lod caster", actor);
    part.setEnabled(true);
    part.material = material;
    expect(attachModelLods(actor, await generateModelLods({ meshes: [source] }))).toBe(1);
    camera.position.set(15, 0, -1.5);
    camera.setTarget(actor.position);
    expect(render()).toBe(6);
    expect(scene.customLODSelector!(part, camera)).toBe(part);
    expect(render()).toBe(0);
    // Stay within the shadow distance so the light keeps its map.
    camera.position.z = -30;
    camera.getViewMatrix(true);
    expect(scene.customLODSelector!(part, camera)).not.toBe(part);
    expect(render()).toBe(0);
  });

  it("ends a point map at its light's range and draws no casters beyond it", async () => {
    const { scene, camera, light, generator, material, render } = await fixture();
    light.range = 10;
    // Straight down the +Z face, inside the camera's 1000 far plane.
    const distant = MeshBuilder.CreateBox("distant caster", {}, scene);
    distant.position.set(0, 3, 40);
    distant.material = material;
    const morphing = MeshBuilder.CreateBox("distant morphing caster", {}, scene);
    morphing.position.set(0, 3, -40);
    morphing.material = material;
    morphing.morphTargetManager = new MorphTargetManager(scene);
    const drawn = new Set<string>();
    const shadowPass = generator as unknown as { _renderSubMeshForShadowMap: (subMesh: SubMesh) => void };
    vi.spyOn(shadowPass, "_renderSubMeshForShadowMap").mockImplementation((subMesh) => {
      drawn.add(subMesh.getMesh().name);
    });
    expect(render()).toBe(6);
    expect(light.getDepthMaxZ(camera)).toBe(10);
    expect([...drawn]).toEqual(["caster"]);
  });

  it("keeps a local map cached while casters outside its range move or animate", async () => {
    const { scene, light, material, render } = await fixture();
    light.range = 10;
    const distant = MeshBuilder.CreateBox("distant caster", {}, scene);
    distant.position.set(40, 0, 0);
    distant.material = material;
    // A per-frame render hook makes a caster's shadow uncacheable.
    const animated = MeshBuilder.CreateBox("animated caster", {}, scene);
    animated.position.set(-40, 0, 0);
    animated.material = material;
    animated.onBeforeRenderObservable.add(() => {});
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    distant.position.x += 1;
    animated.position.x -= 1;
    expect(render()).toBe(0);
    distant.position.set(5, 0, 0);
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    distant.position.set(40, 0, 0);
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    animated.position.set(0, 0, 5);
    expect(render()).toBe(6);
    expect(render()).toBe(6);
  });

  it("keeps local maps cached while the floating render origin moves, sampled from the new origin", async () => {
    const { scene, camera, light, generator, render } = await fixture(true);
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    const buffer = hapticLightBuffer(scene) as unknown as { _bufferData: Float32Array; _uniformLocations: Record<string, number> };
    const views = { first: 0, count: 0 };
    const written = () => {
      // Each frame's admission writes the block (`syncSceneLighting`); this fixture draws without the frame graph.
      writeHapticLights(scene);
      expect(hapticShadowViews(scene, light, views)).toBe(true);
      const at = buffer._uniformLocations["hapticShadowViews"]! + views.first * HAPTIC_SHADOW_VIEW_VEC4S * 4;
      return [...buffer._bufferData.subarray(at, at + 16)];
    };
    const expected = () => {
      const offset = scene.floatingOriginOffset;
      const drawn = (generator as unknown as AtlasShadow).drawnViews[0]!;
      return [...Matrix.Translation(offset.x, offset.y, offset.z).multiply(drawn).m].map(Math.fround);
    };
    expect(written()).toEqual(expected());
    const oldOrigin = scene.floatingOriginOffset.clone();
    camera.position.x += 1;
    // Only the render origin moved: the depth relative to the light is what the map holds.
    expect(render()).toBe(0);
    expect(scene.floatingOriginOffset.equals(oldOrigin)).toBe(false);
    // The light block samples the retained depth from the new origin.
    expect(written()).toEqual(expected());
    expect(written()).not.toEqual([...Matrix.Translation(oldOrigin.x, oldOrigin.y, oldOrigin.z).multiply((generator as unknown as AtlasShadow).drawnViews[0]!).m].map(Math.fround));
    expect(render()).toBe(0);
  });
});

/** A cascaded sun over two boxes, drawn through the real native path. */
async function cascadedSun() {
  const engine = new NullEngine();
  engines.push(engine);
  Object.assign(engine.getCaps(), { maxTexturesImageUnits: 16 });
  // Every shipped Engine draws cascades with hardware depth comparison: the sun's atlas map is one.
  engine._features.supportCSM = true;
  engine._features.supportShadowSamplers = true;
  const scene = new Scene(engine);
  const camera = new UniversalCamera("camera", new Vector3(0, 3, -12), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  updateSceneRenderingSettings(scene, {
    shadows: normalizeShadowSettings({ cascades: 2, distance: 40, mapSize: 512, maxLocalLights: 1 }),
  });
  const added = new Promise<void>((resolve) => scene.onNewMeshAddedObservable.addOnce(() => resolve()));
  const material = new StandardMaterial("opaque", scene);
  const box = (name: string, x: number) => {
    const mesh = MeshBuilder.CreateBox(name, {}, scene);
    mesh.position.set(x, 1, 0);
    mesh.material = material;
    return mesh;
  };
  const near = box("near caster", 2);
  // Far from every cascade.
  const distant = box("distant caster", 200);
  const sun = new DirectionalLight("sun", new Vector3(0.3, -1, 0.4), scene);
  const controller = sceneShadowController(scene);
  controller.register(sun, true);
  await added;
  controller.sync();
  const generator = controller.generator(sun) as CascadedShadowGenerator;
  expect(generator).toBeInstanceOf(CascadedShadowGenerator);
  const map = generator.getShadowMap()!;
  await material.forceCompilationAsync(near);
  await generator.forceCompilationAsync();
  let binds = 0;
  const bindFramebuffer = engine.bindFramebuffer.bind(engine);
  vi.spyOn(engine, "bindFramebuffer").mockImplementation((target, ...args) => {
    if (target === map.renderTarget) binds++;
    bindFramebuffer(target, ...args);
  });
  /** Times the sun map was drawn (every cascade) by one scene frame. */
  const render = () => {
    const before = binds;
    scene.render();
    return (binds - before) / generator.numCascades;
  };
  /** A render feeds the next frame's snapshot once (its derived bias), then the map stays cached. */
  const settle = () => {
    for (let frame = 0; frame < 5; frame++) if (render() === 0) return;
    throw new Error("The sun map kept redrawing.");
  };
  expect(render()).toBeGreaterThan(0);
  settle();
  return { scene, camera, sun, map, generator, material, near, distant, render, settle };
}

describe("cascaded sun refresh", () => {
  it("keeps the cascades cached while nothing that shapes them changes", async () => {
    const { render } = await cascadedSun();
    expect([render(), render(), render()]).toEqual([0, 0, 0]);
  });

  it.each([
    ["the camera moves", ({ camera }) => { camera.position.x += 1; }],
    ["the camera zooms", ({ camera }) => { camera.fov *= 1.2; }],
    ["the light turns", ({ sun }) => { sun.direction = new Vector3(-0.3, -1, 0.2); }],
    ["a caster in a cascade moves", ({ near }) => { near.position.z += 1; }],
  ] as [string, (sun: Awaited<ReturnType<typeof cascadedSun>>) => void][])(
    "redraws once, then caches again, when %s",
    async (_name, change) => {
      const sun = await cascadedSun();
      change(sun);
      expect(sun.render()).toBe(1);
      sun.settle();
      expect([sun.render(), sun.render()]).toEqual([0, 0]);
    },
  );

  it("redraws when a readiness probe left the cascades fitted to another pose", async () => {
    const { camera, map, render, settle } = await cascadedSun();
    const home = camera.position.clone();
    // A probe (here under a moved camera, as another view's would be) refits the
    // cascades the receivers use without drawing the retained depth again.
    camera.position.x += 5;
    map.isReadyForRendering();
    camera.position.copyFrom(home);
    expect(render()).toBe(1);
    settle();
    expect(render()).toBe(0);
  });

  it("redraws every frame while a caster that changes without notice reaches a cascade", async () => {
    const { near, render, settle } = await cascadedSun();
    const hook = near.onBeforeRenderObservable.add(() => {});
    expect([render(), render(), render()]).toEqual([1, 1, 1]);
    near.onBeforeRenderObservable.remove(hook);
    settle();
    expect(render()).toBe(0);
  });

  describe("small far casters", () => {
    /** The fixture with a box of `size` at `position` casting. */
    async function withCaster(size: number, position: Vector3) {
      const sun = await cascadedSun();
      const caster = MeshBuilder.CreateBox(`caster ${size}`, { size }, sun.scene);
      caster.material = sun.material;
      caster.position.copyFrom(position);
      sceneShadowController(sun.scene).setParticipation(caster, { castShadows: true });
      sun.render();
      sun.settle();
      const listed = (layer: number) => {
        const map = sun.map;
        return [...(map.getCustomRenderList!(layer, map.renderList!, map.renderList!.length) ?? [])].includes(caster);
      };
      return { ...sun, caster, listed };
    }
    // Beyond the first cascade's split, inside the second (as the per-cascade caster above).
    const far = new Vector3(0, 1, 30);

    it("leaves a caster too small for a later cascade's texels out of it, and keeps it in the first", async () => {
      const { caster, generator, listed } = await withCaster(0.04, far);
      expect((generator as AtlasCascadedShadowGenerator).farCasterMinTexels).toBe(SHADOW_FAR_CASTER_MIN_TEXELS.medium);
      expect(listed(1)).toBe(false);
      // Near the camera it reaches the first cascade, which draws every caster.
      caster.position.set(2, 1, 0);
      caster.computeWorldMatrix(true);
      expect(listed(0)).toBe(true);
      // With no threshold it is drawn where it reaches.
      (generator as AtlasCascadedShadowGenerator).farCasterMinTexels = 0;
      caster.position.copyFrom(far);
      caster.computeWorldMatrix(true);
      expect(listed(1)).toBe(true);
    });

    it("keeps a large far caster in the later cascade", async () => {
      const { listed } = await withCaster(2, far);
      expect(listed(1)).toBe(true);
    });

    it("redraws nothing for a small far caster that moves, and redraws for a large one", async () => {
      const small = await withCaster(0.04, far);
      small.caster.position.x += 0.5;
      expect(small.render()).toBe(0);
      const large = await withCaster(2, far);
      large.caster.position.x += 0.5;
      expect(large.render()).toBeGreaterThan(0);
    });
  });

  it("ignores casters no cascade can reach, whether static or hooked, and skinned ones beyond the shadow distance", async () => {
    const { scene, distant, render } = await cascadedSun();
    distant.position.x += 1;
    expect(render()).toBe(0);
    distant.onBeforeRenderObservable.add(() => {});
    distant.skeleton = new Skeleton("rig", "rig", scene);
    expect([render(), render()]).toEqual([0, 0]);
  });

  it.each(["skeleton", "morph targets"] as const)(
    "draws every frame for %s geometry within the shadow distance, even outside every cascade's rectangle",
    async (kind) => {
      const { scene, camera, render, settle } = await cascadedSun();
      // A narrow view keeps the rectangles small, so a part beside the camera is
      // beyond twice its radius of each, yet the animated skin could swing into view.
      camera.fov = 0.2;
      settle();
      const part = MeshBuilder.CreateBox("swinging part", {}, scene);
      part.position.set(30, 1, -12);
      if (kind === "skeleton") part.skeleton = new Skeleton("rig", "rig", scene);
      else part.morphTargetManager = new MorphTargetManager(scene);
      expect([render(), render(), render()]).toEqual([1, 1, 1]);
      // Beyond the shadow distance it no longer matters.
      part.position.x = 300;
      settle();
      expect(render()).toBe(0);
    },
  );
});

describe("caster tracking while no map exists", () => {
  const shadows = (enabled: boolean) =>
    normalizeShadowSettings({ enabled, cascades: 1, localMapSize: 256, maxLocalLights: 1 });

  it.each(["existing", "new"] as const)(
    "gives the next map the %s caster state it missed while shadows were off",
    async (kind) => {
      const { scene, mesh, material, light, controller } = await fixture();
      updateSceneRenderingSettings(scene, { shadows: shadows(false) });
      controller.sync();
      expect(controller.generator(light)).toBeNull();
      // A per-frame render hook makes a caster's shadow uncacheable.
      let caster = mesh;
      if (kind === "new") {
        caster = MeshBuilder.CreateBox("late caster", {}, scene);
        caster.material = material;
      }
      caster.onBeforeRenderObservable.add(() => {});
      scene.render();
      updateSceneRenderingSettings(scene, { shadows: shadows(true) });
      controller.sync();
      expect(controller.diagnostics([light])[0]!.refreshMode).toBe("continuous");
    },
  );

  it("releases the geometry hook of a caster removed while no map exists", async () => {
    const { scene, mesh, geometry, light, controller, previousGeometryUpdate } = await fixture();
    expect(geometry.onGeometryUpdated).not.toBe(previousGeometryUpdate);
    updateSceneRenderingSettings(scene, { shadows: shadows(false) });
    controller.sync();
    expect(controller.generator(light)).toBeNull();
    mesh.dispose();
    controller.sync();
    expect(geometry.onGeometryUpdated).toBe(previousGeometryUpdate);
  });
});
