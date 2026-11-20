import { afterEach, describe, expect, it, vi } from "vitest";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { FrameGraphRenderContext } from "@babylonjs/core/FrameGraph/frameGraphRenderContext";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { DECAL_CLASS_ID, RENDER_QUALITY_PROFILES, decalBindings } from "@haptic/core";
import { createDecalGuide } from "./decal-guide";
import {
  clearDecals,
  maxDynamicDecalsForScene,
  removeDecals,
  sceneDecalHost,
  sceneDecalStats,
  sceneDecalTextureGuids,
  sceneHasDecals,
  setDecalTextureResolver,
  setDecalTimePaused,
  setDecalTimeScale,
  spawnDynamicDecal,
  takeDecalTextureRelease,
  upsertDecals,
} from "./decal-pass";
import { createHeadlessEngine } from "./large-world";
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
    expect(host.prepare(camera, true)).toBe(true);
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

  it("caps dynamic decals at the Geometry tier's capacity, fades and expires them, and keeps the pass until cleared", () => {
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
    host.advanceTimers(4);
    expect(host.prepare(camera, true)).toBe(true);
    expect(host.currentBatches).toHaveLength(1);
    expect(host.currentBatches[0]!.items[0]!.opacityMultiplier).toBeCloseTo(0.5);

    // Advance another 1.5 s => all expire, but the scene keeps its decal pass until the decals are cleared.
    host.advanceTimers(1.5);
    expect(host.prepare(camera, true)).toBe(false);
    expect(sceneDecalStats(scene).dynamic).toBe(0);
    expect(sceneHasDecals(scene)).toBe(true);
    clearDecals(scene);
    expect(sceneHasDecals(scene)).toBe(false);

    // The tier, not a value a user can override: Medium's lodDistanceScale at High stays High's capacity.
    updateSceneRenderingSettings(scene, { quality: RENDER_QUALITY_PROFILES.medium });
    expect(maxDynamicDecalsForScene(scene)).toBe(64);
    updateSceneRenderingSettings(scene, { quality: RENDER_QUALITY_PROFILES.high });
    expect(maxDynamicDecalsForScene(scene)).toBe(128);
    updateSceneRenderingSettings(scene, { quality: {
      ...RENDER_QUALITY_PROFILES.high,
      geometry: { ...RENDER_QUALITY_PROFILES.high.geometry, profile: "high", lodDistanceScale: RENDER_QUALITY_PROFILES.medium.geometry.lodDistanceScale },
    } });
    expect(maxDynamicDecalsForScene(scene)).toBe(128);
    updateSceneRenderingSettings(scene, { quality: RENDER_QUALITY_PROFILES.ultra });
    expect(maxDynamicDecalsForScene(scene)).toBe(128);
  });

  it("evicts a dead slot before a live decal, else the oldest live one, and keeps the newest on a downshift", () => {
    const { engine, scene } = createTestEngine();
    disposers.push(() => { scene.dispose(); engine.dispose(); });
    updateSceneRenderingSettings(scene, { quality: RENDER_QUALITY_PROFILES.low });
    const spawn = (textureGuid: string, lifetime = 0) => spawnDynamicDecal(scene, {
      textureGuid, position: [0, 0, 0], rotation: [0, 0, 0, 1], size: [1, 1, 1], lifetime,
    });
    const host = sceneDecalHost(scene);
    spawn("permanent");
    for (let i = 0; i < 63; i += 1) spawn("short", 1);
    host.advanceTimers(2);
    // The 63 expired slots are reused; the permanent decal stays.
    spawn("fresh");
    expect([...sceneDecalTextureGuids(scene)].sort()).toEqual(["fresh", "permanent"]);
    // Full of live decals: the oldest goes first, whatever its lifetime.
    for (let i = 0; i < 62; i += 1) spawn("filler");
    expect(sceneDecalStats(scene).dynamic).toBe(64);
    spawn("newest");
    expect(sceneDecalStats(scene).dynamic).toBe(64);
    expect([...sceneDecalTextureGuids(scene)].sort()).toEqual(["filler", "fresh", "newest"]);

    clearDecals(scene);
    updateSceneRenderingSettings(scene, { quality: RENDER_QUALITY_PROFILES.high });
    for (let i = 0; i < 100; i += 1) spawn(`t${i}`);
    updateSceneRenderingSettings(scene, { quality: RENDER_QUALITY_PROFILES.low });
    const camera = new FreeCamera("cam", new Vector3(0, 2, -10), scene);
    camera.setTarget(Vector3.Zero());
    host.prepare(camera, true);
    expect(sceneDecalStats(scene).dynamic).toBe(64);
    expect(sceneDecalTextureGuids(scene)).toEqual(new Set(Array.from({ length: 64 }, (_, i) => `t${i + 36}`)));
  });

  it("ages dynamic decals once per Engine frame whatever the views, by the time scale, and not while paused", () => {
    const { engine, scene } = createTestEngine();
    disposers.push(() => { scene.dispose(); engine.dispose(); });
    const main = new FreeCamera("main", new Vector3(0, 2, -10), scene);
    main.setTarget(Vector3.Zero());
    const capture = new FreeCamera("capture", new Vector3(0, 10, -1), scene);
    capture.setTarget(Vector3.Zero());
    vi.spyOn(engine, "getDeltaTime").mockReturnValue(1000);
    spawnDynamicDecal(scene, {
      textureGuid: "impact", position: [0, 0, 0], rotation: [0, 0, 0, 1], size: [1, 1, 1], lifetime: 10, fadeOutDuration: 10,
    });
    const host = sceneDecalHost(scene);
    const multiplier = () => host.currentBatches[0]!.items[0]!.opacityMultiplier;
    // A Render Target Capture prepares a second view inside the same frame.
    expect(host.prepare(main, true)).toBe(true);
    expect(host.prepare(capture, true)).toBe(true);
    expect(multiplier()).toBeCloseTo(0.9, 6);
    engine.endFrame();
    host.prepare(main, true);
    expect(multiplier()).toBeCloseTo(0.8, 6);

    setDecalTimePaused(scene, true);
    engine.endFrame();
    host.prepare(main, true);
    expect(multiplier()).toBeCloseTo(0.8, 6);
    setDecalTimePaused(scene, false);
    setDecalTimeScale(scene, 0.5);
    engine.endFrame();
    host.prepare(main, true);
    expect(multiplier()).toBeCloseTo(0.75, 6);
    setDecalTimeScale(scene, 0);
    engine.endFrame();
    host.prepare(main, true);
    expect(multiplier()).toBeCloseTo(0.75, 6);
  });

  it("reports when expiry or eviction may have left a texture unused, once", () => {
    const { engine, scene } = createTestEngine();
    disposers.push(() => { scene.dispose(); engine.dispose(); });
    updateSceneRenderingSettings(scene, { quality: RENDER_QUALITY_PROFILES.low });
    const spawn = (textureGuid: string, lifetime = 0) => spawnDynamicDecal(scene, {
      textureGuid, position: [0, 0, 0], rotation: [0, 0, 0, 1], size: [1, 1, 1], lifetime,
    });
    spawn("short", 1);
    spawn("kept");
    expect(takeDecalTextureRelease(scene)).toBe(false);
    sceneDecalHost(scene).advanceTimers(0.5);
    expect(takeDecalTextureRelease(scene)).toBe(false);
    sceneDecalHost(scene).advanceTimers(1);
    expect(takeDecalTextureRelease(scene)).toBe(true);
    expect(takeDecalTextureRelease(scene)).toBe(false);
    expect([...sceneDecalTextureGuids(scene)]).toEqual(["kept"]);
    for (let i = 0; i < 64; i += 1) spawn("filler");
    expect(takeDecalTextureRelease(scene)).toBe(true);
    expect([...sceneDecalTextureGuids(scene)]).toEqual(["filler"]);
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
    const { engine, scene } = createTestEngine();
    disposers.push(() => { scene.dispose(); engine.dispose(); });
    const camera = new FreeCamera("cam", new Vector3(0, 2, -10), scene);
    camera.setTarget(new Vector3(0, 0, 0));
    camera.getViewMatrix();
    camera.getProjectionMatrix();
    scene.activeCamera = camera;
    scene.updateTransformMatrix();

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
    expect(host.prepare(camera, true)).toBe(true);
    const firstDraws = host.render(fakeContext, camera, 1, 256, 256);
    expect(firstDraws).toBe(1);
    const setsAfterFirstFrame = setBufferSpy.mock.calls.length;
    expect(setsAfterFirstFrame).toBe(7);
    expect(partialUpdateSpy).toHaveBeenCalledTimes(7);

    // Second and third frames (2 batches each: with and without normalTextureGuid) update in place without reallocating GPU buffers.
    spawnDynamicDecal(scene, {
      textureGuid: "albedo-1",
      position: [1, 0, 0],
      rotation: [0, 0, 0, 1],
      size: [1, 1, 1],
    });
    expect(host.prepare(camera, true)).toBe(true);
    expect(host.render(fakeContext, camera, 1, 256, 256)).toBe(2);
    expect(host.render(fakeContext, camera, 1, 256, 256)).toBe(2);
    expect(setBufferSpy).toHaveBeenCalledTimes(setsAfterFirstFrame);
    expect(partialUpdateSpy).toHaveBeenCalledTimes(7 + 14 + 14);

    clearDecals(scene);
    expect(sceneHasDecals(scene)).toBe(false);
    expect(sceneDecalTextureGuids(scene).size).toBe(0);
  });

  describe("drawing", () => {
    type Uploads = { rows: Record<string, number[]>; matrices: Record<string, number[]>; camera: number[] | null; events: string[] };

    /** Prepares and draws `scene`'s decals through a stand-in render context, recording what the draw uploads. */
    async function drawDecals(scene: Scene, camera: FreeCamera): Promise<Uploads> {
      const { Mesh } = await import("@babylonjs/core/Meshes/mesh");
      const { Effect } = await import("@babylonjs/core/Materials/effect");
      const uploads: Uploads = { rows: {}, matrices: {}, camera: null, events: [] };
      vi.spyOn(Mesh.prototype, "thinInstancePartialBufferUpdate").mockImplementation(function (this: unknown, kind: string, data: number | Float32Array) {
        if (typeof data !== "number") uploads.rows[kind] = Array.from(data);
      });
      vi.spyOn(Effect.prototype, "setMatrix").mockImplementation(function (this: InstanceType<typeof Effect>, name: string, matrix) {
        uploads.matrices[name] = Array.from(matrix.asArray());
        return this;
      });
      vi.spyOn(Effect.prototype, "setFloat3").mockImplementation(function (this: InstanceType<typeof Effect>, name: string, x: number, y: number, z: number) {
        if (name === "cameraPosition") uploads.camera = [x, y, z];
        return this;
      });
      vi.spyOn(Effect.prototype, "setVector3").mockImplementation(function (this: InstanceType<typeof Effect>, name: string, value: { x: number; y: number; z: number }) {
        if (name === "cameraPosition") uploads.camera = [value.x, value.y, value.z];
        return this;
      });
      const engine = scene.getEngine();
      vi.spyOn(engine, "setState").mockImplementation((_culling, _offset, _force, reverseSide) => { uploads.events.push(`cull:${reverseSide ? "cw" : "ccw"}`); });
      vi.spyOn(engine, "drawElementsType").mockImplementation(() => { uploads.events.push("draw"); });
      const context = { setTextureSamplingMode: vi.fn(), bindTextureHandle: vi.fn() } as unknown as FrameGraphRenderContext;
      scene.activeCamera = camera;
      scene.updateTransformMatrix();
      const host = sceneDecalHost(scene);
      expect(host.prepare(camera, true)).toBe(true);
      host.render(context, camera, 1, 256, 256);
      return uploads;
    }

    /** Zero's sign is not part of what the shader reads. */
    const unsigned = (values: number[]) => values.map((value) => value + 0);

    async function fakeTexture(scene: Scene) {
      const { Texture } = await import("@babylonjs/core/Materials/Textures/texture");
      const texture = new Texture(null, scene);
      vi.spyOn(texture, "isReadyOrNotBlocking").mockReturnValue(true);
      return texture;
    }

    async function spawnAt1000(scene: Scene): Promise<FreeCamera> {
      const albedo = await fakeTexture(scene);
      setDecalTextureResolver(scene, () => albedo);
      const camera = new FreeCamera("cam", new Vector3(1000, 2, -10), scene);
      camera.setTarget(new Vector3(1000, 0, 0));
      scene.activeCamera = camera;
      spawnDynamicDecal(scene, { textureGuid: "impact", position: [1000, 0, 0], rotation: [0, 0, 0, 1], size: [1, 1, 1] });
      return camera;
    }

    it("uploads absolute positions without Large World Rendering", async () => {
      const { engine, scene } = createTestEngine();
      disposers.push(() => { scene.dispose(); engine.dispose(); });
      const camera = await spawnAt1000(scene);
      const uploads = await drawDecals(scene, camera);
      expect(uploads.rows.matrix!.slice(12, 16)).toEqual([1000, 0, 0, 1]);
      expect(unsigned(uploads.rows.decalInv3!)).toEqual([-1000, 0, 0, 1]);
      expect(uploads.camera).toEqual(camera.globalPosition.asArray());
      expect(uploads.camera![0]).toBeCloseTo(1000, 9);
      expect(uploads.matrices.decalView).toEqual(Array.from(camera.getViewMatrix().asArray()));
    });

    it("uploads every position relative to the floating origin's eye with Large World Rendering", async () => {
      const engine = createHeadlessEngine();
      const scene = new Scene(engine, { useFloatingOrigin: true });
      disposers.push(() => { scene.dispose(); engine.dispose(); });
      expect(scene.floatingOriginMode).toBe(true);
      const camera = await spawnAt1000(scene);
      const uploads = await drawDecals(scene, camera);
      // The instance row's translation less the eye (1000, 2, -10), and the inverse row taking an eye-relative point.
      expect(uploads.rows.matrix!.slice(12, 16)).toEqual([0, -2, 10, 1]);
      expect(uploads.rows.decalInv3).toEqual([0, 2, -10, 1]);
      expect(uploads.camera).toEqual([0, 0, 0]);
      // The view keeps the camera's rotation and puts the eye at the origin, so view-space fog distance is unchanged.
      const view = uploads.matrices.decalView!;
      expect(unsigned(view.slice(0, 12))).toEqual(unsigned(Array.from(camera.getViewMatrix().asArray().slice(0, 12))));
      for (const value of view.slice(12, 15)) expect(Math.abs(value)).toBeLessThan(1e-9);
      // Its inverse view-projection unprojects the decal's own (eye-relative) centre back to where it projects.
      const { Matrix, Vector3: V } = await import("@babylonjs/core/Maths/math.vector");
      const viewProjection = Matrix.FromArray(uploads.matrices.decalViewProjection!);
      const inverse = Matrix.FromArray(uploads.matrices.decalInvViewProjection!);
      const clip = V.TransformCoordinates(new V(0, -2, 10), viewProjection);
      const back = V.TransformCoordinates(clip, inverse);
      expect(back.x).toBeCloseTo(0, 3);
      expect(back.y).toBeCloseTo(-2, 3);
      expect(back.z).toBeCloseTo(10, 3);
    });

    it("draws a mirrored decal's batch with the other face culled", async () => {
      const { engine, scene } = createTestEngine();
      disposers.push(() => { scene.dispose(); engine.dispose(); });
      const albedo = await fakeTexture(scene);
      setDecalTextureResolver(scene, () => albedo);
      const camera = new FreeCamera("cam", new Vector3(0, 2, -10), scene);
      camera.setTarget(Vector3.Zero());
      const plain = new TransformNode("plain", scene);
      const mirrored = new TransformNode("mirrored", scene);
      mirrored.scaling.set(-1, 1, 1);
      const bindings = decalBindings([{ id: "d", classId: DECAL_CLASS_ID, properties: { textureGuid: "scorch" } }]);
      upsertDecals(scene, "plain", plain, bindings);
      upsertDecals(scene, "mirrored", mirrored, bindings);
      const uploads = await drawDecals(scene, camera);
      expect(sceneDecalHost(scene).currentBatches.map((batch) => batch.mirrored)).toEqual([false, true]);
      expect(uploads.events.slice(0, 4)).toEqual(["cull:ccw", "draw", "cull:cw", "draw"]);
    });

    it("samples each texture through its own UV transform", async () => {
      const { engine, scene } = createTestEngine();
      disposers.push(() => { scene.dispose(); engine.dispose(); });
      const albedo = await fakeTexture(scene);
      const normal = await fakeTexture(scene);
      // As ResourceCache flips a KTX2 texture.
      albedo.vScale = -1;
      albedo.vOffset = 1;
      setDecalTextureResolver(scene, (guid) => (guid === "albedo" ? albedo : normal));
      const camera = new FreeCamera("cam", new Vector3(0, 2, -10), scene);
      camera.setTarget(Vector3.Zero());
      spawnDynamicDecal(scene, { textureGuid: "albedo", normalTextureGuid: "normal", position: [0, 0, 0], rotation: [0, 0, 0, 1], size: [1, 1, 1] });
      const uploads = await drawDecals(scene, camera);
      expect(uploads.matrices.decalAlbedoMatrix).toEqual(Array.from(albedo.getTextureMatrix().asArray()));
      expect(uploads.matrices.decalAlbedoMatrix).not.toEqual(Array.from(normal.getTextureMatrix().asArray()));
      expect(uploads.matrices.decalNormalMatrix).toEqual(Array.from(normal.getTextureMatrix().asArray()));
    });
  });
});
