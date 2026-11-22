import { afterEach, describe, expect, it, vi } from "vitest";
import { CascadedShadowGenerator } from "@babylonjs/core/Lights/Shadows/cascadedShadowGenerator";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Material } from "@babylonjs/core/Materials/material";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { MorphTargetManager } from "@babylonjs/core/Morph/morphTargetManager";
import { NullEngine, NullEngineOptions } from "@babylonjs/core/Engines/nullEngine";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { SpotLight } from "@babylonjs/core/Lights/spotLight";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Scene } from "@babylonjs/core/scene";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
// Registers thin instances, which the fixture adds.
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { DynamicRuntimeMeshGeometry, normalizeShadowSettings, SHADOW_FAR_CASTER_MIN_TEXELS } from "@haptic/core";
import { applyDynamicRuntimeMeshUpdate, createDynamicRuntimeMesh } from "./dynamic-runtime-mesh";
import { sceneShadowController, type SceneShadowController } from "./shadow-controller";
import { attachModelLods, generateModelLods } from "./model-lod";
import { updateSceneRenderingSettings } from "./render-settings";
import { applyCableFrame, createCableMesh } from "./cable-mesh";
import { createLandscapeMesh, updateLandscapeMesh } from "./landscape-mesh";
import { createSpriteQuad, setSpriteQuadSize, setSpriteQuadUvs } from "./sprite-quad";
import { createTilemapMeshes, updateSceneTilemapAnimations } from "./tilemap-mesh";
import { createDefaultTilemapPayload, normalizeTilesetPayload, setTile, type TilemapPayload } from "@haptic/assets";
import { ShadowMapRefresh } from "./shadow-map-refresh";
import { setShadowDistanceCulled } from "./shadow-caster-list";
import { onSceneReadinessDirty } from "./scene-readiness-signal";
import { verifyRenderChangeJournal } from "./render-change-journal";
import { BoundingInfo } from "@babylonjs/core/Culling/boundingInfo";
import { hasMeshLatticeDeformer, setLatticeBinding } from "./lattice-deformer-binding";
import { refreshMeshLatticeDeformer, setMeshLatticeDeformer, type LatticeDeformerConfig } from "./lattice-deformer";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial";
import { InternalTexture, InternalTextureSource } from "@babylonjs/core/Materials/Textures/internalTexture";
import { followPose, updatePoseBounds } from "./pose-bounds";
import { skinnedRig, skinnedStrip } from "./skinned-test-fixtures";
import { ReflectedContent } from "./reflected-content";
import { shadowAtlasDrawCounts, type AtlasCascadedShadowGenerator } from "./shadow-atlas";
import { HAPTIC_SHADOW_VIEW_VEC4S, hapticLightBuffer, hapticShadowViews, writeHapticLights } from "./haptic-lights";
import type { AtlasShadow } from "./shadow-atlas";

const engines: NullEngine[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) engine.dispose();
});

/**
 * Production refreshes the admitted maps from the forward graph's shadow task (`ManagedShadowsTask`), after the frame's
 * world matrices update and before any map draws. These fixtures draw with Babylon's Scene.render, which draws the maps
 * itself, so they refresh at the same point: once per camera pass, after its active meshes are evaluated.
 */
function refreshLikeTheGraph(scene: Scene, controller: SceneShadowController): void {
  scene.onAfterActiveMeshesEvaluationObservable.add(() => controller.refreshShadowMaps());
}

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
  refreshLikeTheGraph(scene, controller);
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
    // Neither geometry nor parts draws nothing: the map, which it cannot change, keeps its depth. The geometry it later
    // gets is tracked.
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
    const properties = { width: 4, depth: 4, subdivisions: 4, heights: new Float32Array(25) };
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
    updateLandscapeMesh(root, { ...properties, heights: Float32Array.from(properties.heights, (_, index) => (index === 12 ? 1 : 0)) });
    for (const chunk of chunks) chunk.material = material;
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    root.dispose();
  });

  it("caches sprite quads and animated tilemap chunks, whose owners notify every write, and redraws in the frame one is rewritten", async () => {
    const { scene, material, controller, render } = await fixture();
    const sprite = createSpriteQuad(scene, "sprite", { pivot: { x: 0.5, y: 0.5 }, width: 100, height: 100 });
    sprite.material = material;
    controller.setParticipation(sprite, { castShadows: true });
    // Its buffers are updatable: without its owner's word it would redraw every frame.
    expect(sprite.getVertexBuffer(VertexBuffer.PositionKind)!.isUpdatable()).toBe(true);
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    setSpriteQuadSize(sprite, 2, 1, { x: 0.5, y: 0.5 });
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    setSpriteQuadUvs(sprite, { u0: 0, v0: 0, u1: 0.5, v1: 0.5 });
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    sprite.dispose();
    expect(render()).toBe(6);

    const tileset = normalizeTilesetPayload({ atlasWidth: 32, atlasHeight: 16, tileWidth: 16, tileHeight: 16, tiles: [{ id: 2, animation: [2, 1] }] });
    let tilemap: TilemapPayload = { ...createDefaultTilemapPayload(), chunkSize: 2, tilesets: [{ guid: "atlas", firstGid: 1, tileCount: 2 }] };
    tilemap = setTile(tilemap, "layer-1", 0, 0, 2);
    const root = createTilemapMeshes(scene, "tiles", tilemap, new Map([["atlas", tileset]]), 1, 1);
    const chunk = root.getChildMeshes().find((mesh) => mesh.name.endsWith(":anim")) as Mesh;
    chunk.material = material;
    controller.setParticipation(chunk, { castShadows: true });
    expect(chunk.getVertexBuffer(VertexBuffer.UVKind)!.isUpdatable()).toBe(true);
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    // The next animation frame rewrites its UVs.
    updateSceneTilemapAnimations(scene, 100);
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

  it("follows a moving light's casters in place, making no kept caster or seen entry anew each frame", async () => {
    // The break: a light that moves every frame (one on a player) reads every caster each frame (`scanLocal`), which
    // made a Map and an object per caster in range, and an entry per caster entering it: garbage every frame.
    const { scene, light, map, material, controller, render } = await fixture();
    light.range = 10;
    const other = MeshBuilder.CreateBox("other caster", {}, scene);
    other.position.set(4, 3, 0);
    other.material = material;
    controller.setParticipation(other, { castShadows: true });
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    const refresh = (controller as unknown as { refresh: ShadowMapRefresh }).refresh as unknown as {
      localRanges: WeakMap<object, { members: Map<object, object> }>;
      seen: WeakMap<object, Map<object, object>>;
    };
    const members = refresh.localRanges.get(map)!.members;
    const kept = [...members.values()];
    expect(kept).toHaveLength(2);
    for (const x of [0.5, 1, 1.5]) {
      light.position.x = x;
      expect(render()).toBe(6);
    }
    expect(refresh.localRanges.get(map)!.members).toBe(members);
    expect([...members.values()].every((member, index) => member === kept[index])).toBe(true);
    // The light leaves the other caster out of range: it leaves the kept casters, and its moves no longer redraw.
    const seenOther = refresh.seen.get(map)!.get(other);
    expect(seenOther).toBeDefined();
    light.position.x = -8;
    expect(render()).toBe(6);
    expect(members.size).toBe(1);
    expect(refresh.seen.get(map)!.has(other)).toBe(false);
    other.position.y += 1;
    expect(render()).toBe(0);
    // Back in range, it is kept again, in the entry it left.
    light.position.x = 0;
    expect(render()).toBe(6);
    expect(members.size).toBe(2);
    expect(refresh.seen.get(map)!.get(other)).toBe(seenOther);
    expect(render()).toBe(0);
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

  it("keeps a spot map cached while casters in its range but outside its cone move or animate, and redraws for one that can reach it", async () => {
    const engine = new NullEngine();
    engines.push(engine);
    Object.assign(engine.getCaps(), { maxTexturesImageUnits: 16, maxTextureSize: 4096 });
    const scene = new Scene(engine);
    const camera = new UniversalCamera("camera", new Vector3(0, 2, -10), scene);
    camera.setTarget(Vector3.Zero());
    scene.activeCamera = camera;
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ cascades: 1, localMapSize: 256, maxLocalLights: 1 }) });
    const material = new StandardMaterial("opaque", scene);
    const under = MeshBuilder.CreateBox("under", {}, scene);
    under.material = material;
    // 6 m up, pointing down, 40 degrees wide: its map's square frustum reaches about 27 degrees off its axis at the corners.
    const light = new SpotLight("spot", new Vector3(0, 6, 0), new Vector3(0, -1, 0), (40 * Math.PI) / 180, 2, scene);
    light.range = 20;
    // Within its range, level with it and well off its axis; one changes on every frame by itself.
    const beside = MeshBuilder.CreateBox("beside", {}, scene);
    beside.position.set(8, 5, 0);
    beside.material = material;
    const animated = MeshBuilder.CreateBox("animated", {}, scene);
    animated.position.set(-8, 5, 0);
    animated.material = material;
    animated.onBeforeRenderObservable.add(() => {});
    const controller = sceneShadowController(scene);
    refreshLikeTheGraph(scene, controller);
    controller.register(light, true);
    controller.sync();
    const generator = controller.generator(light)!;
    const map = generator.getShadowMap()!;
    const bind = map._bindFrameBuffer.bind(map);
    const passes = vi.spyOn(map, "_bindFrameBuffer").mockImplementation((...args) => bind(...args));
    await material.forceCompilationAsync(under);
    await generator.forceCompilationAsync();
    const render = () => {
      const before = passes.mock.calls.length;
      scene.render();
      return passes.mock.calls.length - before;
    };
    // Drawn, and drawn again once every caster's shadow shader is ready.
    expect(render()).toBe(1);
    render();
    expect(render()).toBe(0);
    beside.position.z += 1;
    animated.position.z += 1;
    expect([render(), render()]).toEqual([0, 0]);
    // On the floor toward a corner of the map, about 34 degrees off the axis: its edge reaches into the map's frustum,
    // though not into the light's 20 degree cone.
    beside.position.set(2.8, 0, 2.8);
    expect(render()).toBe(1);
    expect(render()).toBe(0);
    beside.position.set(8, 5, 0);
    expect(render()).toBe(1);
    expect(render()).toBe(0);
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

/** A cascaded sun over two boxes. */
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
  refreshLikeTheGraph(scene, controller);
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

describe("casters that draw nothing", () => {
  afterEach(() => verifyRenderChangeJournal(false));

  /**
   * The fixture with an actor's root (a plain mesh without geometry) casting beside the caster, after the map's first
   * draw. `listed` redraws the map and gives every caster its faces listed (no retained buffer on NullEngine, so these
   * are Babylon's own lists); `misses` the list and walk disagreements counted since its last call.
   */
  async function rooted() {
    const scene = await fixture();
    const root = new Mesh("actor root", scene.scene);
    root.material = scene.material;
    root.position.x = 1;
    scene.controller.setParticipation(root, { castShadows: true });
    expect(scene.render()).toBe(6);
    expect(scene.render()).toBe(0);
    const captured = new Set<AbstractMesh>();
    const list = scene.map.getCustomRenderList!.bind(scene.map);
    scene.map.getCustomRenderList = (...args) => {
      const result = list(...args);
      for (const mesh of result ?? []) captured.add(mesh);
      return result;
    };
    const listed = () => {
      captured.clear();
      scene.map.resetRefreshCounter();
      scene.scene.render();
      return new Set(captured);
    };
    let last = scene.controller.journalDiagnostics();
    const misses = () => {
      const now = scene.controller.journalDiagnostics();
      const step = now.mismatches - last.mismatches;
      last = now;
      return step;
    };
    return { ...scene, root, misses, listed };
  }

  it("lists a root in no layer, and redraws no map when it moves or shows, as it cannot change one", async () => {
    verifyRenderChangeJournal(true);
    const { root, mesh, render, listed, misses, controller } = await rooted();
    const casters = listed();
    expect(casters.has(root)).toBe(false);
    expect(casters.has(mesh)).toBe(true);
    root.position.y = 1;
    expect(render()).toBe(0);
    root.isVisible = false;
    expect(render()).toBe(0);
    root.isVisible = true;
    expect(render()).toBe(0);
    expect(misses()).toBe(0);
    expect(controller.journalDiagnostics().missedKinds).toEqual([]);
  });

  it("lists a root in the frame it gains geometry, and leaves it out in the frame it loses it", async () => {
    verifyRenderChangeJournal(true);
    const { root, render, listed, misses } = await rooted();
    VertexData.CreateBox({}).applyToMesh(root);
    await root.material!.forceCompilationAsync(root);
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    expect(listed().has(root)).toBe(true);
    root.geometry!.releaseForMesh(root);
    expect(root.geometry).toBeNull();
    // Its depth leaves the map.
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    expect(listed().has(root)).toBe(false);
    expect(misses()).toBe(0);
  });

  it("lists a root's instance as before, and both once the root gains geometry", async () => {
    verifyRenderChangeJournal(true);
    const { root, listed, misses, controller } = await rooted();
    const instance = root.createInstance("root instance");
    instance.position.x = -1;
    controller.setParticipation(instance, { castShadows: true });
    let casters = listed();
    expect(casters.has(root)).toBe(false);
    expect(casters.has(instance)).toBe(true);
    VertexData.CreateBox({}).applyToMesh(root);
    await root.material!.forceCompilationAsync(root);
    casters = listed();
    expect(casters.has(root)).toBe(true);
    expect(casters.has(instance)).toBe(true);
    expect(misses()).toBe(0);
  });

  it("keeps a root out when only its child gains geometry or it moves under another node, and lists it with a level of detail", async () => {
    verifyRenderChangeJournal(true);
    const { scene, root, listed, misses, controller, material } = await rooted();
    const child = new Mesh("root child", scene);
    child.parent = root;
    child.material = material;
    controller.setParticipation(child, { castShadows: true });
    VertexData.CreateBox({}).applyToMesh(child);
    await material.forceCompilationAsync(child);
    let casters = listed();
    expect(casters.has(child)).toBe(true);
    expect(casters.has(root)).toBe(false);
    const holder = new TransformNode("holder", scene);
    root.parent = holder;
    holder.position.z = 1;
    expect(listed().has(root)).toBe(false);
    const level = MeshBuilder.CreateBox("root level", {}, scene);
    level.material = material;
    root.addLODLevel(1000, level);
    casters = listed();
    expect(casters.has(root)).toBe(true);
    expect(misses()).toBe(0);
  });

  it("forgets a disposed root, and lists the casters that take a removed one's place as a full read does", async () => {
    verifyRenderChangeJournal(true);
    const { scene, root, mesh, render, listed, misses, controller, material } = await rooted();
    const late = MeshBuilder.CreateBox("late caster", {}, scene);
    late.material = material;
    late.position.x = -1;
    controller.setParticipation(late, { castShadows: true });
    await material.forceCompilationAsync(late);
    expect(render()).toBe(6);
    root.dispose();
    expect(render()).toBe(0);
    // The last caster takes the removed one's place in the list.
    mesh.dispose();
    expect(render()).toBe(6);
    expect(listed().has(late)).toBe(true);
    expect(misses()).toBe(0);
  });

  it("counts a layer list that disagrees with the full read, draws the full one, and sets the kept flag right", async () => {
    verifyRenderChangeJournal(true);
    const { mesh, listed, misses, controller } = await rooted();
    // Corrupt what the lists keep: the caster is marked as drawing nothing.
    (controller as unknown as { spatial: { setDraws(mesh: AbstractMesh, draws: boolean): void } }).spatial.setDraws(mesh, false);
    expect(listed().has(mesh)).toBe(true);
    expect(misses()).toBeGreaterThan(0);
    expect(controller.journalDiagnostics().missedKinds).toContain("casterLists");
    verifyRenderChangeJournal(false);
    expect(listed().has(mesh)).toBe(true);
  });
});

describe("shadow distance cull", () => {
  afterEach(() => verifyRenderChangeJournal(false));

  it("redraws the map in the frame a caster crosses its shadow distance, heard through the journal, without readiness", async () => {
    const { scene, mesh, render, controller } = await fixture();
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    const readiness: string[] = [];
    const unsubscribe = onSceneReadinessDirty(scene, (reason) => readiness.push(reason));
    // The journal walk alone (the full walk runs only every 32nd frame) finds each crossing.
    setShadowDistanceCulled(mesh, true);
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    setShadowDistanceCulled(mesh, false);
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    // And the full walk that follows every journal walk while verifying finds nothing the journal walk missed.
    verifyRenderChangeJournal(true);
    const before = controller.journalDiagnostics().mismatches;
    setShadowDistanceCulled(mesh, true);
    expect(render()).toBe(6);
    setShadowDistanceCulled(mesh, false);
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    expect(controller.journalDiagnostics().mismatches).toBe(before);
    expect(controller.journalDiagnostics().missedKinds).toEqual([]);
    unsubscribe();
    expect(readiness).toEqual([]);
  });
});

describe("cascaded sun refresh", () => {
  it("keeps the cascades cached while nothing that shapes them changes", async () => {
    const { render } = await cascadedSun();
    expect([render(), render(), render()]).toEqual([0, 0, 0]);
  });

  it("hands the atlas one refresh for every frame, which still redraws for a change", async () => {
    // The break: a refresh closure made for every map on every frame.
    const sun = await cascadedSun();
    const refreshCascades = vi.spyOn(sun.generator as AtlasCascadedShadowGenerator, "refreshCascades");
    expect(sun.render()).toBe(0);
    sun.near.position.z += 1;
    expect(sun.render()).toBe(1);
    sun.settle();
    expect(refreshCascades.mock.calls.length).toBeGreaterThan(2);
    expect(new Set(refreshCascades.mock.calls.map((call) => call[1])).size).toBe(1);
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

  it("redraws only the cascades a caster that changes on its own reaches, keeping the other's tile, and every cascade when the camera moves", async () => {
    const { scene, camera, material, generator } = await cascadedSun();
    const counts = shadowAtlasDrawCounts(scene);
    /** The cascade tiles one scene frame cleared and drew. */
    const tiles = () => {
      const before = counts.tiles;
      scene.render();
      return counts.tiles - before;
    };
    // Thirty units ahead, beyond the first cascade's split; a render hook makes its shadow change on its own.
    const far = MeshBuilder.CreateBox("far animated caster", { size: 2 }, scene);
    far.position.set(0, 1, 30);
    far.material = material;
    far.onBeforeRenderObservable.add(() => {});
    sceneShadowController(scene).setParticipation(far, { castShadows: true });
    tiles();
    tiles();
    expect([tiles(), tiles(), tiles()]).toEqual([1, 1, 1]);
    expect([generator.numCascades, (generator as AtlasCascadedShadowGenerator).keepsCascade(0)]).toEqual([2, true]);
    // A moved camera refits every cascade: both are drawn, then the first is kept again.
    camera.position.x += 1;
    expect([tiles(), tiles()]).toEqual([2, 1]);
  });

  it("draws a skinned caster into the cascades its pose reaches, once its bounds follow its skeleton", async () => {
    const sun = await cascadedSun();
    const { scene, map, material } = sun;
    const engine = scene.getEngine();
    const controller = sceneShadowController(scene);
    const { skeleton, root } = skinnedRig(scene);
    // Stands by the camera, in the first cascade.
    const character = skinnedStrip(scene, skeleton, "character");
    character.material = material;
    character.position.set(2, 1, 0);
    // What a rigid caster of the pose's own box does is what the posed one must: a box where the strip is posed.
    const reference = MeshBuilder.CreateBox("reference", { width: 1, height: 2, depth: 0.02 }, scene);
    reference.material = material;
    for (const mesh of [character, reference]) controller.setParticipation(mesh, { castShadows: true });
    const listed = (mesh: AbstractMesh) => [0, 1].map((layer) => [...(map.getCustomRenderList!(layer, map.renderList!, map.renderList!.length) ?? [])].includes(mesh));
    /** Poses the strip `x`, `z` from where it stands, with the reference box around the posed strip. */
    const pose = (x: number, z: number) => {
      root.position = new Vector3(x, 0, z);
      reference.position.set(2 + x + 0.5, 1 + 1, z);
      reference.computeWorldMatrix(true);
      character.computeWorldMatrix(true);
      engine.beginFrame();
      updatePoseBounds(scene);
      engine.endFrame();
      sun.render();
    };
    // Beyond the first cascade's split, inside the second: thirty units ahead, as the per-cascade caster above.
    pose(-2, 30);
    expect(listed(reference)).toEqual([false, true]);
    // Not followed, its bounds say nothing of its pose: every cascade draws it.
    expect(listed(character)).toEqual([true, true]);
    // A Scene's cull follows it (`cullSceneByWhatShows`, `settlePlayViewCulling`): now it draws where the box does.
    expect(followPose(character)).toBe(true);
    expect(listed(character)).toEqual([false, true]);
    // Posed back to where it stands, it leaves the far cascade's list for the near one's, as the box does.
    pose(0, 0);
    expect(listed(character)).toEqual(listed(reference));
    expect(listed(character)[0]).toBe(true);
  });

  it("leaves a skinned caster too small for a later cascade's texels out of it, once its bounds follow its skeleton", async () => {
    const sun = await cascadedSun();
    const { scene, map, material } = sun;
    const { skeleton, root } = skinnedRig(scene);
    // A strip four hundredths wide, as the small rigid caster below, posed thirty units ahead in the second cascade.
    const tiny = skinnedStrip(scene, skeleton, "tiny", [0, 0, 0, 0.04, 0, 0, 0, 0.04, 0, 0.04, 0.04, 0]);
    tiny.material = material;
    tiny.position.set(0, 1, 0);
    root.position = new Vector3(0, 0, 30);
    sceneShadowController(scene).setParticipation(tiny, { castShadows: true });
    sun.render();
    const listed = () => [...(map.getCustomRenderList!(1, map.renderList!, map.renderList!.length) ?? [])].includes(tiny);
    // Deforming bounds are not the caster's: it is drawn in case.
    expect(listed()).toBe(true);
    expect(followPose(tiny)).toBe(true);
    expect(listed()).toBe(false);
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

    it("tests each caster against the cascades without allocating per caster or cascade", async () => {
      // The break: a one-matrix array and a view of the cascades' scales (`subarray`) made for every caster and
      // cascade on each frame's refresh, which a far caster threshold (on at every level) always takes.
      const sun = await withCaster(0.04, far);
      expect((sun.generator as AtlasCascadedShadowGenerator).farCasterMinTexels).toBeGreaterThan(0);
      const subarray = vi.spyOn(Float64Array.prototype, "subarray");
      sceneShadowController(sun.scene).refreshShadowMaps();
      expect(subarray).not.toHaveBeenCalled();
      subarray.mockRestore();
      // The same casters still decide the cascades: a small far one moving redraws nothing.
      sun.caster.position.x += 0.5;
      expect(sun.render()).toBe(0);
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

describe("reflected shadows", () => {
  /** The sun fixture with a shadowed floor under the near caster and a far caster inside the cascades. */
  async function reflectedFloor() {
    const sun = await cascadedSun();
    const floor = MeshBuilder.CreateGround("floor", { width: 4, height: 4 }, sun.scene);
    floor.position.set(2, 0, 0);
    floor.material = sun.material;
    floor.receiveShadows = true;
    const far = MeshBuilder.CreateBox("far caster", {}, sun.scene);
    far.position.set(-10, 1, 10);
    far.material = sun.material;
    sun.render();
    sun.settle();
    // What a reflection shows: the floor, whose shadows come from the near caster.
    const content = new ReflectedContent();
    const changed = () => content.changed(sun.scene, [floor]);
    changed();
    expect(changed()).toBe(false);
    return { ...sun, floor, far, changed };
  }

  it("keeps a reflection while a caster whose shadow cannot reach what it shows moves, and redraws it for one that can", async () => {
    const { far, near, render, settle, changed } = await reflectedFloor();
    far.position.x -= 1;
    expect(render()).toBe(1);
    expect(changed()).toBe(false);
    near.position.x += 0.5;
    expect(render()).toBe(1);
    expect(changed()).toBe(true);
    settle();
    expect(changed()).toBe(false);
  });

  it("keeps a reflection while a far caster deforms on every frame, and redraws it while a near one does", async () => {
    const { scene, far, near, render, changed } = await reflectedFloor();
    far.skeleton = new Skeleton("rig", "rig", scene);
    for (let frame = 0; frame < 3; frame++) {
      expect(render()).toBe(1);
      expect(changed()).toBe(false);
    }
    near.skeleton = new Skeleton("near rig", "near rig", scene);
    render();
    for (let frame = 0; frame < 3; frame++) {
      expect(render()).toBe(1);
      expect(changed()).toBe(true);
    }
  });

  it("redraws a reflection for a pass that skipped a caster not ready, and for the pass that completes it", async () => {
    const { generator, far, render, settle, changed } = await reflectedFloor();
    // The far caster's move alone reaches nothing shown; the skipped caster could be any.
    vi.spyOn(generator, "isReady").mockReturnValueOnce(false);
    far.position.x -= 1;
    expect(render()).toBe(1);
    expect(changed()).toBe(true);
    expect(render()).toBe(1);
    expect(changed()).toBe(true);
    settle();
    expect(changed()).toBe(false);
  });

  it("redraws a reflection whenever the map changes everywhere: a turned light or a caster it cannot bound", async () => {
    const { sun, far, render, settle, changed } = await reflectedFloor();
    sun.direction = new Vector3(-0.3, -1, 0.2);
    render();
    expect(changed()).toBe(true);
    settle();
    expect(changed()).toBe(false);
    far.onBeforeRenderObservable.add(() => {});
    expect(render()).toBe(1);
    expect(changed()).toBe(true);
  });
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

describe("what casters share", () => {
  it("reads a Material and a source mesh once per walk, and every caster follows a change of either", () => {
    const engine = new NullEngine();
    engines.push(engine);
    const scene = new Scene(engine);
    const material = new StandardMaterial("shared", scene);
    const first = MeshBuilder.CreateBox("first", {}, scene);
    const second = MeshBuilder.CreateBox("second", {}, scene);
    first.material = second.material = material;
    const instance = first.createInstance("instance");
    const casters = new Set<AbstractMesh>([first, second, instance]);
    let reads = 0, offset = 0;
    Object.defineProperty(material, "zOffset", { get: () => { reads += 1; return offset; }, set: (value: number) => { offset = value; } });
    const levels = vi.spyOn(first, "getLODLevels");
    const changed: AbstractMesh[] = [];
    const refresh = new ShadowMapRefresh((mesh) => changed.push(mesh));
    const revisions = () => [first, second, instance].map((mesh) => refresh.casterState(mesh)!.revision);

    refresh.syncCasters(scene, casters);
    expect(reads).toBe(1);
    // The source of two casters: itself and its instance.
    expect(levels).toHaveBeenCalledTimes(1);
    const walked = revisions();
    changed.length = 0;
    refresh.syncCasters(scene, casters);
    expect(revisions()).toEqual(walked);
    expect(changed).toEqual([]);

    // The Material's depth state is every caster's.
    offset = 2;
    refresh.syncCasters(scene, casters);
    expect(revisions()).toEqual(walked.map((revision) => revision + 1));
    expect(changed).toEqual([first, second, instance]);

    // A source's parts are its own and its instance's, not another mesh's.
    changed.length = 0;
    first.subMeshes[0]!.indexCount -= 3;
    refresh.syncCasters(scene, casters);
    expect(changed).toEqual([first, instance]);

    // A cage that deforms the instance alone keeps its shadow live, and its source's cached.
    expect(refresh.casterState(instance)!.safe).toBe(true);
    setLatticeBinding(instance, { active: true, revision: () => 0, widens: () => true } as unknown as Parameters<typeof setLatticeBinding>[1]);
    refresh.syncCasters(scene, casters);
    expect(refresh.casterState(instance)!.safe).toBe(false);
    expect(refresh.casterState(first)!.safe).toBe(true);
    setLatticeBinding(instance);
    refresh.dispose();
  });
});

describe("the changed-set caster pipeline", () => {
  afterEach(() => verifyRenderChangeJournal(false));

  /** The fixture with a second caster and the light's range bounded, and what the stages counted since the last call. */
  async function pipeline() {
    const scene = await fixture();
    scene.light.range = 10;
    const other = MeshBuilder.CreateBox("other caster", {}, scene.scene);
    other.material = scene.material;
    other.position.x = 2;
    scene.controller.setParticipation(other, { castShadows: true });
    await scene.material.forceCompilationAsync(other);
    expect(scene.render()).toBe(6);
    expect(scene.render()).toBe(0);
    let last = scene.controller.journalDiagnostics();
    const counted = () => {
      const now = scene.controller.journalDiagnostics();
      const step = {
        localVisited: now.localVisited - last.localVisited, localScans: now.localScans - last.localScans,
        prepared: now.prepared - last.prepared, prepareScans: now.prepareScans - last.prepareScans,
        cascadeSkips: now.cascadeSkips - last.cascadeSkips, mismatches: now.mismatches - last.mismatches,
      };
      last = now;
      return step;
    };
    return { ...scene, other, counted };
  }

  it("refreshes a local map from the casters that changed, as a read of every caster agrees, for each change kind", async () => {
    verifyRenderChangeJournal(true);
    const { scene, other, light, render, counted } = await pipeline();
    counted();
    // Nothing changed: no caster read, no redraw.
    expect(render()).toBe(0);
    expect(counted()).toMatchObject({ localVisited: 0, prepared: 0, localScans: 0, prepareScans: 0, mismatches: 0 });
    // A move within the range: that caster alone.
    other.position.z = 1;
    expect(render()).toBe(6);
    expect(counted()).toMatchObject({ localVisited: 1, prepared: 1, mismatches: 0 });
    // Out of the range: it leaves the map, which draws without it.
    other.position.x = 50;
    expect(render()).toBe(6);
    expect(counted()).toMatchObject({ localVisited: 1, mismatches: 0 });
    // A caster out of range that moves changes nothing the map draws.
    other.position.x = 60;
    expect(render()).toBe(0);
    expect(counted()).toMatchObject({ localVisited: 1, mismatches: 0 });
    // Back in range, then hidden, then removed.
    other.position.x = 2;
    expect(render()).toBe(6);
    other.isVisible = false;
    expect(render()).toBe(6);
    other.dispose();
    expect(render()).toBe(6);
    expect(counted()).toMatchObject({ mismatches: 0 });
    // The light moves: every caster is read again.
    light.position.y = 4;
    expect(render()).toBe(6);
    expect(counted()).toMatchObject({ localScans: 1, mismatches: 0 });
    expect(render()).toBe(0);
    void scene;
  });

  it("counts a kept caster box a bounds change no walk saw left stale, and redraws everywhere to heal it", async () => {
    verifyRenderChangeJournal(true);
    const { other, render, counted } = await pipeline();
    counted();
    // New bounds with no world matrix change: no write the walk follows.
    other.setBoundingInfo(new BoundingInfo(new Vector3(-2, -2, -2), new Vector3(2, 2, 2), other.getWorldMatrix()));
    expect(render()).toBe(6);
    expect(counted().mismatches).toBeGreaterThan(0);
    expect(render()).toBe(0);
    expect(counted().mismatches).toBe(0);
  });

  it("leaves out a cascaded map's casters while its view moves, and draws no more once the view stops unless a caster changed", async () => {
    const { scene, camera, controller, other, counted } = await pipeline();
    const engine = scene.getEngine();
    engine._features.supportCSM = true;
    engine._features.supportShadowSamplers = true;
    const sun = new DirectionalLight("sun", new Vector3(0, -1, 1), scene);
    controller.register(sun, true);
    controller.sync();
    const sunlight = controller.generator(sun)!;
    await sunlight.forceCompilationAsync();
    const sunMap = sunlight.getShadowMap()!;
    const bindSun = sunMap._bindFrameBuffer.bind(sunMap);
    const sunDraw = vi.spyOn(sunMap, "_bindFrameBuffer").mockImplementation((...args) => bindSun(...args));
    const frame = () => {
      const before = sunDraw.mock.calls.length;
      scene.render();
      return sunDraw.mock.calls.length - before;
    };
    frame();
    frame();
    counted();
    // Moving: the map draws each frame, and its caster bookkeeping is left out.
    camera.position.x += 1;
    expect(frame()).toBe(1);
    camera.position.x += 1;
    expect(frame()).toBe(1);
    expect(counted().cascadeSkips).toBe(2);
    // Stopped, nothing else changed: the depth it drew holds.
    expect(frame()).toBe(0);
    expect(frame()).toBe(0);
    // Stopped while a caster moved: that frame draws.
    camera.position.x += 1;
    expect(frame()).toBe(1);
    other.position.y = 1;
    expect(frame()).toBe(1);
    expect(frame()).toBe(0);
  });
});

/**
 * The cascaded sun fixture with per-cascade counts: `tiles` renders one scene frame and returns the cascade tiles it
 * drew, `listed` which cascades' caster lists hold a mesh, and `misses` the list and walk disagreements a full read
 * found since its last call (every frame is checked while `verifyRenderChangeJournal` is on).
 */
async function cascadedTiles() {
  const sun = await cascadedSun();
  const { scene, map } = sun;
  const counts = shadowAtlasDrawCounts(scene);
  const tiles = () => {
    const before = counts.tiles;
    scene.render();
    return counts.tiles - before;
  };
  const settleTiles = () => {
    for (let frame = 0; frame < 5; frame++) if (tiles() === 0) return;
    throw new Error("The sun map kept redrawing.");
  };
  const listed = (mesh: AbstractMesh) => [0, 1].map((layer) => [...(map.getCustomRenderList!(layer, map.renderList!, map.renderList!.length) ?? [])].includes(mesh));
  const controller = sceneShadowController(scene);
  let last = controller.journalDiagnostics();
  const misses = () => {
    const now = controller.journalDiagnostics();
    const step = now.mismatches - last.mismatches;
    last = now;
    return step;
  };
  return { ...sun, controller, tiles, settleTiles, listed, misses };
}

/**
 * Draws frames until the sun map's depth programs for each of `mesh`'s parts are ready: a depth wrapper or a new
 * Material builds its program over frames, and a pass that skips a caster not ready redraws every cascade until it is.
 */
async function depthReady(sun: Awaited<ReturnType<typeof cascadedTiles>>, mesh: AbstractMesh) {
  const ready = () => mesh.subMeshes.every((part) => sun.generator.isReady(part, false, false));
  for (let attempt = 0; attempt < 50 && !ready(); attempt++) {
    sun.tiles();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(ready()).toBe(true);
}

describe("casters whose every part blends", () => {
  afterEach(() => verifyRenderChangeJournal(false));

  /** A translucent sphere by the camera, in the first cascade: Babylon's shadow pass draws none of its parts. */
  async function glass(padding = 0) {
    const sun = await cascadedTiles();
    const glassMaterial = new StandardMaterial("glass", sun.scene);
    glassMaterial.alpha = 0.5;
    // As an authored World Position Offset asks: bounds that do not hold what it draws, so it cannot be tracked.
    if (padding) glassMaterial.metadata = { boundsPadding: padding };
    const sphere = MeshBuilder.CreateSphere("glass sphere", { diameter: 1.5 }, sun.scene);
    sphere.position.set(-2, 1, 0);
    sphere.material = glassMaterial;
    sun.controller.setParticipation(sphere, { castShadows: true });
    await glassMaterial.forceCompilationAsync(sphere);
    sun.tiles();
    sun.settleTiles();
    return { ...sun, sphere, glassMaterial };
  }

  it.each([["rigid", 0], ["with padded bounds", 0.25]] as [string, number][])(
    "keeps every cascade while a still view holds only a %s translucent caster, which is in no layer's list",
    async (_name, padding) => {
      verifyRenderChangeJournal(true);
      const { sphere, tiles, listed, misses } = await glass(padding);
      expect([tiles(), tiles(), tiles()]).toEqual([0, 0, 0]);
      expect(listed(sphere)).toEqual([false, false]);
      expect(misses()).toBe(0);
    },
  );

  it("joins the lists in the frame its Material turns opaque, and leaves them in the frame it blends again", async () => {
    verifyRenderChangeJournal(true);
    const { sphere, glassMaterial, tiles, settleTiles, listed, misses } = await glass();
    glassMaterial.alpha = 1;
    expect(tiles()).toBeGreaterThan(0);
    expect(listed(sphere)[0]).toBe(true);
    settleTiles();
    expect(tiles()).toBe(0);
    glassMaterial.alpha = 0.5;
    // Its depth leaves the cascades it was drawn into.
    expect(tiles()).toBeGreaterThan(0);
    expect(listed(sphere)).toEqual([false, false]);
    settleTiles();
    expect(misses()).toBe(0);
  });

  it("follows a fading caster: one whose visibility is below one blends however opaque its Material", async () => {
    const { sphere, glassMaterial, tiles, settleTiles, listed } = await glass();
    glassMaterial.alpha = 1;
    settleTiles();
    expect(listed(sphere)[0]).toBe(true);
    sphere.visibility = 0.5;
    expect(tiles()).toBeGreaterThan(0);
    expect(listed(sphere)).toEqual([false, false]);
    settleTiles();
    expect(tiles()).toBe(0);
  });

  it("lists a caster with one opaque part beside blended ones, and blended ones under a map that draws them", async () => {
    const sun = await glass();
    const { scene, sphere, glassMaterial, generator, tiles, listed, settleTiles } = sun;
    const opaque = new StandardMaterial("opaque part", scene);
    const parts = new MultiMaterial("parts", scene);
    parts.subMaterials.push(glassMaterial, opaque);
    sphere.material = parts;
    const count = sphere.getTotalIndices();
    const vertices = sphere.getTotalVertices();
    sphere.subMeshes = [];
    new SubMesh(0, 0, vertices, 0, count / 2, sphere);
    new SubMesh(1, 0, vertices, count / 2, count / 2, sphere);
    await opaque.forceCompilationAsync(sphere);
    await depthReady(sun, sphere);
    // A Material of parts is not one the refresh can vouch for: drawing, the caster redraws what it reaches each frame.
    expect(tiles()).toBeGreaterThan(0);
    expect(tiles()).toBeGreaterThan(0);
    expect(listed(sphere)[0]).toBe(true);
    // A Material of parts the refresh polls nothing of: the swap is read from the parts each walk.
    parts.subMaterials[1] = glassMaterial;
    tiles();
    settleTiles();
    expect(listed(sphere)).toEqual([false, false]);
    generator.transparencyShadow = true;
    tiles();
    expect(listed(sphere)[0]).toBe(true);
  });
});

describe("lattice casters", () => {
  afterEach(() => verifyRenderChangeJournal(false));

  /** A cage's offsets: every control moved `x` along X. */
  const cage = (x: number): LatticeDeformerConfig => ({
    enabled: true, resolution: [2, 2, 2], strength: 1, offsets: Array.from({ length: 24 }, (_, index) => index % 3 === 0 ? x : 0),
    fitToMesh: true, boundsMin: [-1, -1, -1], boundsMax: [1, 1, 1],
  });

  /**
   * A caged box thirty units ahead, in the second cascade only (as the per-cascade caster above), under a component
   * root. NullEngine has no 3D texture backend: only the cage texture's allocation and upload are stood in for.
   */
  async function caged() {
    const sun = await cascadedTiles();
    const { scene, controller } = sun;
    const engine = scene.getEngine() as NullEngine;
    engine.getCaps().textureFloat = true;
    engine.getCaps().maxVertexTextureImageUnits = 16;
    vi.spyOn(engine, "webGLVersion", "get").mockReturnValue(2);
    vi.spyOn(engine, "createRawTexture3D").mockImplementation((_data, width, height, depth) => {
      const texture = new InternalTexture(engine, InternalTextureSource.Raw3D);
      texture.width = width; texture.height = height; texture.depth = depth;
      texture.isReady = true;
      return texture;
    });
    vi.spyOn(engine, "updateRawTexture3D").mockImplementation(() => {});
    const root = new Mesh("cage root", scene);
    root.position.set(0, 1, 30);
    const box = MeshBuilder.CreateBox("caged box", { size: 2 }, scene);
    box.parent = root;
    const surface = new StandardMaterial("caged surface", scene);
    box.material = surface;
    setMeshLatticeDeformer(root, cage(1));
    controller.setParticipation(box, { castShadows: true });
    await surface.forceCompilationAsync(box);
    await depthReady(sun, box);
    sun.settleTiles();
    return { ...sun, root, box, surface };
  }

  it("keeps every cascade while the view and the cage are still, and lists the box only where its widened bounds reach", async () => {
    verifyRenderChangeJournal(true);
    const { box, tiles, listed, misses } = await caged();
    expect(hasMeshLatticeDeformer(box)).toBe(true);
    expect([tiles(), tiles(), tiles()]).toEqual([0, 0, 0]);
    expect(listed(box)).toEqual([false, true]);
    expect(misses()).toBe(0);
  });

  it.each([
    ["the cage changes", ({ root }: Awaited<ReturnType<typeof caged>>) => setMeshLatticeDeformer(root, cage(1.5))],
    ["the root moves", ({ root }: Awaited<ReturnType<typeof caged>>) => { root.position.z += 0.5; }],
    ["the root turns", ({ root }: Awaited<ReturnType<typeof caged>>) => { root.rotation.y += 0.3; }],
  ])("redraws only the cascade the caged box reaches when %s, keeping the other's tile", async (_name, change) => {
    verifyRenderChangeJournal(true);
    const sun = await caged();
    change(sun);
    expect(sun.tiles()).toBe(1);
    expect((sun.generator as AtlasCascadedShadowGenerator).keepsCascade(0)).toBe(true);
    sun.settleTiles();
    expect(sun.tiles()).toBe(0);
    expect(sun.misses()).toBe(0);
  });

  it("redraws for a cage the walk finds only through its root, whose matrix is all that changed", async () => {
    const sun = await caged();
    const { root, box } = sun;
    // The box keeps its world matrix (frozen where it stands); only the cage's root moves under it.
    box.freezeWorldMatrix();
    root.position.x += 0.5;
    expect(sun.tiles()).toBe(1);
    sun.settleTiles();
  });

  it("keeps a caged caster live, drawn into every cascade, until its cage widens its bounds", async () => {
    const sun = await caged();
    const { scene, root, controller, surface } = sun;
    // Parented under the root after the cage gathered its parts: the cage deforms it, but did not widen its bounds.
    const late = MeshBuilder.CreateBox("late part", { size: 1 }, scene);
    late.material = surface;
    late.parent = root;
    controller.setParticipation(late, { castShadows: true });
    expect(hasMeshLatticeDeformer(late)).toBe(true);
    await depthReady(sun, late);
    expect([sun.tiles(), sun.tiles()]).toEqual([2, 2]);
    expect(sun.listed(late)).toEqual([true, true]);
    // The cage gathers it, widening its bounds: from then on it is tracked as the others are.
    refreshMeshLatticeDeformer(root);
    sun.settleTiles();
    expect(sun.tiles()).toBe(0);
    expect(sun.listed(late)).toEqual([false, true]);
  });
});
