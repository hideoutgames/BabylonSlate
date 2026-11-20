import { afterEach, describe, expect, it, vi } from "vitest";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { DECAL_CLASS_ID, RENDER_QUALITY_PROFILES, decalBindings } from "@haptic/core";
import { createDecalGuide } from "./decal-guide";
import {
  maxDynamicDecalsForScene,
  removeDecals,
  sceneDecalHost,
  sceneDecalStats,
  sceneHasDecals,
  spawnDynamicDecal,
  upsertDecals,
} from "./decal-pass";
import { updateSceneRenderingSettings } from "./render-settings";
import { createTestEngine } from "./test-support/test-engine";

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
  vi.restoreAllMocks();
});

describe("projected decal pass", () => {
  it("batches identical decals, sorts by sortOrder, and culls by frustum and quality-scaled distance", () => {
    const { engine, scene } = createTestEngine();
    disposers.push(() => { scene.dispose(); engine.dispose(); });
    const camera = new FreeCamera("cam", new Vector3(0, 2, -10), scene);
    camera.setTarget(new Vector3(0, 0, 0));
    camera.getViewMatrix();
    camera.getProjectionMatrix();
    scene.activeCamera = camera;
    updateSceneRenderingSettings(scene, { quality: RENDER_QUALITY_PROFILES.low });

    const rootA = new TransformNode("actor-a", scene);
    rootA.position.set(0, 0, 0);
    const rootB = new TransformNode("actor-b", scene);
    rootB.position.set(2, 0, 0);
    const rootBehind = new TransformNode("actor-behind", scene);
    rootBehind.position.set(0, 0, -40);
    const rootFar = new TransformNode("actor-far", scene);
    rootFar.position.set(0, 0, 60);

    upsertDecals(scene, "a", rootA, decalBindings([
      { id: "d1", classId: DECAL_CLASS_ID, properties: { textureGuid: "scorch", sortOrder: 2 } },
      { id: "d2", classId: DECAL_CLASS_ID, properties: { textureGuid: "cracks", sortOrder: 0, receiveLighting: false } },
    ]));
    upsertDecals(scene, "b", rootB, decalBindings([
      { id: "d3", classId: DECAL_CLASS_ID, properties: { textureGuid: "scorch", sortOrder: 2 } },
    ]));
    upsertDecals(scene, "behind", rootBehind, decalBindings([
      { id: "d4", classId: DECAL_CLASS_ID, properties: { textureGuid: "scorch", sortOrder: 2 } },
    ]));
    // Low quality lodDistanceScale = 0.75 => effective cull = 40 * 0.75 = 30 m (actor-far is ~70 m away).
    upsertDecals(scene, "far", rootFar, decalBindings([
      { id: "d5", classId: DECAL_CLASS_ID, properties: { textureGuid: "scorch", cullDistance: 40 } },
    ]));

    expect(sceneHasDecals(scene)).toBe(true);
    const host = sceneDecalHost(scene);
    expect(host.prepare(camera, 0, true)).toBe(true);
    expect(host.currentBatches.map((batch) => ({
      textureGuid: batch.textureGuid,
      sortOrder: batch.sortOrder,
      count: batch.items.length,
    }))).toEqual([
      { textureGuid: "cracks", sortOrder: 0, count: 1 },
      { textureGuid: "scorch", sortOrder: 2, count: 2 },
    ]);
    expect(sceneDecalStats(scene)).toMatchObject({
      authored: 5,
      visible: 3,
      batches: 2,
    });

    removeDecals(scene, "a");
    removeDecals(scene, "b");
    removeDecals(scene, "behind");
    removeDecals(scene, "far");
    expect(sceneHasDecals(scene)).toBe(false);
  });

  it("caps dynamic decals at quality ring-buffer capacity and fades/expires over lifetime", () => {
    const { engine, scene } = createTestEngine();
    disposers.push(() => { scene.dispose(); engine.dispose(); });
    const camera = new FreeCamera("cam", new Vector3(0, 2, -10), scene);
    camera.setTarget(new Vector3(0, 0, 0));
    camera.getViewMatrix();
    camera.getProjectionMatrix();
    scene.activeCamera = camera;

    updateSceneRenderingSettings(scene, { quality: RENDER_QUALITY_PROFILES.low });
    expect(maxDynamicDecalsForScene(scene)).toBe(64);
    for (let i = 0; i < 80; i += 1) {
      spawnDynamicDecal(scene, {
        textureGuid: "bullet-hole",
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        size: [0.5, 0.5, 0.5],
        lifetime: 5,
        fadeOutDuration: 2,
      });
    }
    expect(sceneDecalStats(scene).dynamic).toBe(64);

    // Advance 4 s (1 s left inside 2 s fade window => opacityMultiplier = 0.5).
    const host = sceneDecalHost(scene);
    expect(host.prepare(camera, 4, true)).toBe(true);
    expect(host.currentBatches).toHaveLength(1);
    expect(host.currentBatches[0]!.items[0]!.opacityMultiplier).toBeCloseTo(0.5);

    // Advance another 1.5 s => all expire.
    expect(host.prepare(camera, 1.5, true)).toBe(false);
    expect(sceneDecalStats(scene).dynamic).toBe(0);
    expect(sceneHasDecals(scene)).toBe(false);

    updateSceneRenderingSettings(scene, { quality: RENDER_QUALITY_PROFILES.high });
    expect(maxDynamicDecalsForScene(scene)).toBe(128);
  });

  it("creates a pickable editor OBB guide with a projection arrow outline", () => {
    const { engine, scene } = createTestEngine();
    disposers.push(() => { scene.dispose(); engine.dispose(); });
    const guide = createDecalGuide(scene, "decal-guide", { size: [3, 1.5, 2] });
    expect(guide.isPickable).toBe(true);
    expect(guide.metadata).toMatchObject({ editorVolume: true, decalGuide: true });
    const outline = guide.getChildMeshes().find((mesh) => mesh.name === "decal-guide:outline");
    expect(outline).toBeDefined();
    expect(outline!.isPickable).toBe(false);
  });

  it("reuses dynamic thin-instance buffers across decal frames and tracks active texture guids", async () => {
    const { Mesh } = await import("@babylonjs/core/Meshes/mesh");
    const { Texture } = await import("@babylonjs/core/Materials/Textures/texture");
    const { clearDecals, sceneDecalTextureGuids, setDecalTextureResolver } = await import("./decal-pass");
    const { engine, scene } = createTestEngine();
    disposers.push(() => { scene.dispose(); engine.dispose(); });
    const camera = new FreeCamera("cam", new Vector3(0, 2, -10), scene);
    camera.setTarget(new Vector3(0, 0, 0));
    camera.getViewMatrix();
    camera.getProjectionMatrix();
    scene.activeCamera = camera;

    const fakeAlbedo = new Texture(null, scene);
    vi.spyOn(fakeAlbedo, "isReadyOrNotBlocking").mockReturnValue(true);
    setDecalTextureResolver(scene, (guid) => (guid === "albedo-1" ? fakeAlbedo : null));

    spawnDynamicDecal(scene, {
      textureGuid: "albedo-1",
      normalTextureGuid: "normal-1",
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      size: [1, 1, 1],
    });
    expect([...sceneDecalTextureGuids(scene)].sort()).toEqual(["albedo-1", "normal-1"]);

    const setBufferSpy = vi.spyOn(Mesh.prototype, "thinInstanceSetBuffer");
    const partialUpdateSpy = vi.spyOn(Mesh.prototype, "thinInstancePartialBufferUpdate");
    const fakeContext = {
      setTextureSamplingMode: vi.fn(),
      bindTextureHandle: vi.fn(),
    } as unknown as import("@babylonjs/core/FrameGraph/frameGraphRenderContext").FrameGraphRenderContext;

    const host = sceneDecalHost(scene);
    expect(host.prepare(camera, 0, true)).toBe(true);
    const firstDraws = host.render(fakeContext, camera, 1, 256, 256);
    expect(firstDraws).toBe(1);
    const setsAfterFirstFrame = setBufferSpy.mock.calls.length;
    expect(setsAfterFirstFrame).toBe(7);
    expect(partialUpdateSpy).toHaveBeenCalledTimes(7);

    // Second and third frames within capacity must update in place without reallocating GPU buffers.
    spawnDynamicDecal(scene, {
      textureGuid: "albedo-1",
      position: [1, 0, 0],
      rotation: [0, 0, 0, 1],
      size: [1, 1, 1],
    });
    expect(host.prepare(camera, 0, true)).toBe(true);
    expect(host.render(fakeContext, camera, 1, 256, 256)).toBe(1);
    expect(host.render(fakeContext, camera, 1, 256, 256)).toBe(1);
    expect(setBufferSpy).toHaveBeenCalledTimes(setsAfterFirstFrame);
    expect(partialUpdateSpy).toHaveBeenCalledTimes(21);

    clearDecals(scene);
    expect(sceneHasDecals(scene)).toBe(false);
    expect(sceneDecalTextureGuids(scene).size).toBe(0);
  });
});

