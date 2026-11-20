import { afterEach, describe, expect, it, vi } from "vitest";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { FrameGraphRenderContext } from "@babylonjs/core/FrameGraph/frameGraphRenderContext";
import { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import type { Material } from "@babylonjs/core/Materials/material";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { DECAL_CLASS_ID, RENDER_QUALITY_PROFILES, decalBindings, type DynamicDecalSpawnRequest } from "@haptic/core";
import { createDefaultMaterialDocument, lowerMaterialDocument, type MaterialBlendMode } from "@haptic/shader-graph";
import { createDecalGuide } from "./decal-guide";
import {
  clearDecals,
  maxDynamicDecalsForScene,
  refreshDecalMaterials,
  removeDecals,
  sceneDecalHost,
  sceneDecalsPending,
  sceneDecalStats,
  sceneHasDecals,
  setDecalMaterialSource,
  setDecalPendingListener,
  setDecalTimePaused,
  setDecalTimeScale,
  spawnDynamicDecal,
  upsertDecals,
  warmDecalMaterials,
  type DecalMaterialInstance,
} from "./decal-pass";
import { compileMaterialPlan } from "./material-compiler";
import { createHeadlessEngine } from "./large-world";
import { updateSceneRenderingSettings } from "./render-settings";
import { createTestEngine } from "./test-support/test-engine";

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
  vi.restoreAllMocks();
});

function testScene(): Scene {
  const { engine, scene } = createTestEngine();
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  return scene;
}

function cameraAt(scene: Scene, position = new Vector3(0, 2, -10), target = Vector3.Zero()): FreeCamera {
  const camera = new FreeCamera("cam", position, scene);
  camera.setTarget(target);
  camera.getViewMatrix();
  camera.getProjectionMatrix();
  scene.activeCamera = camera;
  return camera;
}

/** A stand-in Decal Material: what the host groups and draws by, without a program. */
function stubDecalMaterial(scene: Scene, name: string, domain = "decal"): NodeMaterial {
  const material = new NodeMaterial(name, scene);
  material.metadata = { materialDomain: domain };
  return material;
}

/** A source that hands out one stand-in Material per guid and records what it was asked. */
function stubSource(scene: Scene) {
  const materials = new Map<string, NodeMaterial>();
  const resolved: Array<{ guid: string; instance?: DecalMaterialInstance }> = [];
  const released: Array<[string, string]> = [];
  const source = {
    resolve: (guid: string, instance?: DecalMaterialInstance) => {
      resolved.push({ guid, instance });
      const key = instance ? `${guid}:${instance.key}` : guid;
      let material = materials.get(key);
      if (!material) materials.set(key, (material = stubDecalMaterial(scene, key)));
      return material;
    },
    release: (key: string, guid: string) => { released.push([key, guid]); },
  };
  setDecalMaterialSource(scene, source);
  return { materials, resolved, released };
}

const spawnAt = (scene: Scene, materialGuid: string, extra: Partial<DynamicDecalSpawnRequest> = {}) => spawnDynamicDecal(scene, {
  materialGuid, position: [0, 0, 0], rotation: [0, 0, 0, 1], size: [1, 1, 1], ...extra,
});

/** The guid each prepared batch draws, by the stand-in Material's name. */
function batchGuids(scene: Scene): string[] {
  return sceneDecalHost(scene).currentBatches.flatMap((batch) => batch.items.map(() => batch.material.name));
}

describe("projected decal pass", () => {
  it("batches decals by sort order, Material and winding, and culls by frustum and quality-scaled distance", () => {
    const scene = testScene();
    const camera = cameraAt(scene);
    updateSceneRenderingSettings(scene, { quality: RENDER_QUALITY_PROFILES.low });
    stubSource(scene);

    const rootA = new TransformNode("actor-a", scene);
    const rootB = new TransformNode("actor-b", scene);
    rootB.position.set(2, 0, 0);
    const rootBehind = new TransformNode("actor-behind", scene);
    rootBehind.position.set(0, 0, -40);
    const rootFar = new TransformNode("actor-far", scene);
    rootFar.position.set(0, 0, 60);

    upsertDecals(scene, "a", rootA, decalBindings([
      { id: "d1", classId: DECAL_CLASS_ID, properties: { materialGuid: "scorch", sortOrder: 2 } },
      { id: "d2", classId: DECAL_CLASS_ID, properties: { materialGuid: "cracks", sortOrder: 0 } },
    ]));
    upsertDecals(scene, "b", rootB, decalBindings([
      { id: "d3", classId: DECAL_CLASS_ID, properties: { materialGuid: "scorch", sortOrder: 2, tint: [1, 0, 0], opacity: 0.5 } },
    ]));
    upsertDecals(scene, "behind", rootBehind, decalBindings([
      { id: "d4", classId: DECAL_CLASS_ID, properties: { materialGuid: "scorch", sortOrder: 2 } },
    ]));
    // Low quality lodDistanceScale = 0.75 => effective cull = 40 * 0.75 = 30 m (actor-far is ~70 m away).
    upsertDecals(scene, "far", rootFar, decalBindings([
      { id: "d5", classId: DECAL_CLASS_ID, properties: { materialGuid: "scorch", cullDistance: 40 } },
    ]));

    expect(sceneHasDecals(scene)).toBe(true);
    const host = sceneDecalHost(scene);
    expect(host.prepare(camera, true)).toBe(true);
    // Decals of one Material share a batch whatever their own Tint and Opacity.
    expect(host.currentBatches.map((batch) => ({ material: batch.material.name, sortOrder: batch.sortOrder, count: batch.items.length })))
      .toEqual([{ material: "cracks", sortOrder: 0, count: 1 }, { material: "scorch", sortOrder: 2, count: 2 }]);
    expect(sceneDecalStats(scene)).toMatchObject({ authored: 5, visible: 3, batches: 2 });

    for (const id of ["a", "b", "behind", "far"]) removeDecals(scene, id);
    expect(sceneHasDecals(scene)).toBe(false);
  });

  it("draws only Decal-domain Materials, and asks again for a Material disposed after a refresh", () => {
    const scene = testScene();
    const camera = cameraAt(scene);
    let current: NodeMaterial | null = stubDecalMaterial(scene, "first");
    const surface = stubDecalMaterial(scene, "surface", "surface");
    const resolve = vi.fn((guid: string) => guid === "surface" ? surface : current);
    setDecalMaterialSource(scene, { resolve });
    const root = new TransformNode("root", scene);
    upsertDecals(scene, "decal", root, decalBindings([
      { id: "d", classId: DECAL_CLASS_ID, properties: { materialGuid: "mud" } },
      { id: "s", classId: DECAL_CLASS_ID, properties: { materialGuid: "surface" } },
    ]));
    const host = sceneDecalHost(scene);
    host.prepare(camera, true);
    // A Surface Material in a decal's slot draws nothing.
    expect(batchGuids(scene)).toEqual(["first"]);

    // A new generation replaces the first: the next prepare after the refresh draws it.
    const first = current!;
    current = stubDecalMaterial(scene, "second");
    first.dispose();
    host.prepare(camera, true);
    expect(batchGuids(scene)).toEqual([]);
    const calls = resolve.mock.calls.length;
    host.prepare(camera, true);
    // Not asked again every frame while the source has nothing new.
    expect(resolve.mock.calls.length).toBe(calls);
    refreshDecalMaterials(scene);
    host.prepare(camera, true);
    expect(batchGuids(scene)).toEqual(["second"]);
  });

  it("keeps a component's own Material values as a private copy while they stay the same, and releases it when they go", () => {
    const scene = testScene();
    const { resolved, released } = stubSource(scene);
    const root = new TransformNode("root", scene);
    const binding = (tint: number) => decalBindings([{
      id: "d", classId: DECAL_CLASS_ID, properties: { materialGuid: "mud" },
      materialInstance: { materialGuid: "mud", parameters: { Tint: { kind: "color", value: [tint, 0, 0, 1] } } },
    }]);
    upsertDecals(scene, "actor", root, binding(1));
    const first = resolved.at(-1)!;
    expect(first.guid).toBe("mud");
    expect([...first.instance!.parameters]).toEqual([["Tint", { kind: "color", value: [1, 0, 0, 1] }]]);
    // Moving the decal (same values) keeps the copy.
    upsertDecals(scene, "actor", root, decalBindings([{
      id: "d", classId: DECAL_CLASS_ID, properties: { materialGuid: "mud", size: [3, 1, 3] },
      materialInstance: { materialGuid: "mud", parameters: { Tint: { kind: "color", value: [1, 0, 0, 1] } } },
    }]));
    expect(released).toEqual([]);
    // New values take a new copy and release the old one.
    upsertDecals(scene, "actor", root, binding(0.5));
    expect(resolved.at(-1)!.instance!.key).not.toBe(first.instance!.key);
    expect(released).toEqual([[first.instance!.key, "mud"]]);
    const second = resolved.at(-1)!.instance!.key;
    removeDecals(scene, "actor");
    expect(released).toEqual([[first.instance!.key, "mud"], [second, "mud"]]);
  });

  it("caps dynamic decals at the Geometry tier's capacity, fades and expires them, and keeps the pass until cleared", () => {
    const scene = testScene();
    const camera = cameraAt(scene);
    stubSource(scene);
    updateSceneRenderingSettings(scene, { quality: RENDER_QUALITY_PROFILES.low });
    expect(maxDynamicDecalsForScene(scene)).toBe(64);
    for (let i = 0; i < 80; i += 1) spawnAt(scene, "bullet-hole", { size: [0.5, 0.5, 0.5], lifetime: 5, fadeOutDuration: 2 });
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

  it("evicts an expired decal before a live one, else the oldest live one, and keeps the newest on a downshift", () => {
    const scene = testScene();
    const camera = cameraAt(scene);
    stubSource(scene);
    updateSceneRenderingSettings(scene, { quality: RENDER_QUALITY_PROFILES.low });
    const host = sceneDecalHost(scene);
    const live = () => { host.prepare(camera, true); return [...new Set(batchGuids(scene))].sort(); };
    spawnAt(scene, "permanent");
    for (let i = 0; i < 63; i += 1) spawnAt(scene, "short", { lifetime: 1 });
    host.advanceTimers(2);
    // The 63 expired places are reused; the permanent decal stays.
    spawnAt(scene, "fresh");
    expect(live()).toEqual(["fresh", "permanent"]);
    // Full of live decals: the oldest goes first, whatever its lifetime.
    for (let i = 0; i < 62; i += 1) spawnAt(scene, "filler");
    expect(sceneDecalStats(scene).dynamic).toBe(64);
    spawnAt(scene, "newest");
    expect(sceneDecalStats(scene).dynamic).toBe(64);
    expect(live()).toEqual(["filler", "fresh", "newest"]);

    clearDecals(scene);
    updateSceneRenderingSettings(scene, { quality: RENDER_QUALITY_PROFILES.high });
    for (let i = 0; i < 100; i += 1) spawnAt(scene, `t${i}`);
    updateSceneRenderingSettings(scene, { quality: RENDER_QUALITY_PROFILES.low });
    expect(live()).toEqual(Array.from({ length: 64 }, (_, i) => `t${i + 36}`).sort());
    expect(sceneDecalStats(scene).dynamic).toBe(64);
  });

  it("ages dynamic decals once per Engine frame whatever the views, by the time scale, and not while paused", () => {
    const scene = testScene();
    const engine = scene.getEngine();
    stubSource(scene);
    const main = cameraAt(scene);
    const capture = new FreeCamera("capture", new Vector3(0, 10, -1), scene);
    capture.setTarget(Vector3.Zero());
    vi.spyOn(engine, "getDeltaTime").mockReturnValue(1000);
    spawnAt(scene, "impact", { lifetime: 10, fadeOutDuration: 10 });
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

  it("creates a pickable editor OBB guide with a projection arrow outline", () => {
    const scene = testScene();
    const guide = createDecalGuide(scene, "decal-guide", { size: [3, 1.5, 2] });
    expect(guide.isPickable).toBe(true);
    expect(guide.metadata).toMatchObject({ editorVolume: true, decalGuide: true });
    const outline = guide.getChildMeshes().find((mesh) => mesh.name === "decal-guide:outline");
    expect(outline).toBeDefined();
    expect(outline!.isPickable).toBe(false);
  });

  describe("drawing", () => {
    type Uploads = { rows: Record<string, number[]>; matrices: Record<string, number[]>; camera: number[] | null; events: string[] };

    /** A real Decal Material, compiled and built. */
    async function compiledDecal(scene: Scene, blendMode: MaterialBlendMode = "translucent"): Promise<Material> {
      const lowered = lowerMaterialDocument({ ...createDefaultMaterialDocument("Decal", "decal"), shadingModel: "unlit", blendMode });
      if (!lowered.ok) throw new Error("did not lower");
      const compiled = compileMaterialPlan(lowered.plan, { scene, name: `decal-${blendMode}` });
      if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
      expect(await compiled.ready).toEqual([]);
      return compiled.material;
    }

    /** Draws `scene`'s decals through a stand-in render context, recording what the draw uploads. */
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
      vi.spyOn(Effect.prototype, "setVector3").mockImplementation(function (this: InstanceType<typeof Effect>, name: string, value: { x: number; y: number; z: number }) {
        if (name === "decalCameraPosition") uploads.camera = [value.x, value.y, value.z];
        return this;
      });
      const engine = scene.getEngine();
      vi.spyOn(engine, "setState").mockImplementation((_culling, _offset, _force, reverseSide) => { uploads.events.push(`cull:${reverseSide ? "cw" : "ccw"}`); });
      vi.spyOn(engine, "setAlphaMode").mockImplementation((mode) => { uploads.events.push(`alpha:${mode}`); });
      vi.spyOn(engine, "drawElementsType").mockImplementation((_fill, _start, _count, instances) => { uploads.events.push(`draw:${instances}`); });
      const context = { setTextureSamplingMode: vi.fn(), bindTextureHandle: vi.fn() } as unknown as FrameGraphRenderContext;
      scene.activeCamera = camera;
      scene.updateTransformMatrix();
      const host = sceneDecalHost(scene);
      host.prepare(camera, true);
      host.render(context, camera, 1, 256, 256);
      return uploads;
    }

    /** Zero's sign is not part of what the shader reads. */
    const unsigned = (values: number[]) => values.map((value) => value + 0);

    async function spawnAt1000(scene: Scene): Promise<FreeCamera> {
      const material = await compiledDecal(scene);
      setDecalMaterialSource(scene, { resolve: () => material });
      expect(await warmDecalMaterials(scene, [material])).toBe(1);
      const camera = cameraAt(scene, new Vector3(1000, 2, -10), new Vector3(1000, 0, 0));
      spawnAt(scene, "impact", { position: [1000, 0, 0], tint: [1, 0.5, 0.25], opacity: 0.8 });
      return camera;
    }

    it("uploads absolute positions and each decal's own Tint and Opacity without Large World Rendering", async () => {
      const scene = testScene();
      const camera = await spawnAt1000(scene);
      const uploads = await drawDecals(scene, camera);
      expect(uploads.rows.matrix!.slice(12, 16)).toEqual([1000, 0, 0, 1]);
      expect(unsigned(uploads.rows.decalInv3!)).toEqual([-1000, 0, 0, 1]);
      expect(uploads.rows.decalTintOpacity!.map((value) => Math.round(value * 1000) / 1000)).toEqual([1, 0.5, 0.25, 0.8]);
      expect(uploads.camera![0]).toBeCloseTo(1000, 9);
      expect(uploads.matrices.decalView).toEqual(Array.from(camera.getViewMatrix().asArray()));
      // The warmed Material drew its decal, so no extra first draw follows it.
      expect(uploads.events.filter((event) => event.startsWith("draw"))).toEqual(["draw:1"]);
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
      const { Matrix, Vector3: V } = await import("@babylonjs/core/Maths/math.vector");
      const viewProjection = Matrix.FromArray(uploads.matrices.decalViewProjection!);
      const inverse = Matrix.FromArray(uploads.matrices.decalInvViewProjection!);
      const back = V.TransformCoordinates(V.TransformCoordinates(new V(0, -2, 10), viewProjection), inverse);
      expect(back.x).toBeCloseTo(0, 3);
      expect(back.y).toBeCloseTo(-2, 3);
      expect(back.z).toBeCloseTo(10, 3);
    });

    it("draws each Material's batch with its own alpha mode, and a mirrored decal's with the other face culled", async () => {
      const scene = testScene();
      const multiply = await compiledDecal(scene, "multiply");
      const additive = await compiledDecal(scene, "additive");
      setDecalMaterialSource(scene, { resolve: (guid) => guid === "stain" ? multiply : additive });
      await warmDecalMaterials(scene, [multiply, additive]);
      const camera = cameraAt(scene);
      const plain = new TransformNode("plain", scene);
      const mirrored = new TransformNode("mirrored", scene);
      mirrored.scaling.set(-1, 1, 1);
      upsertDecals(scene, "plain", plain, decalBindings([{ id: "d", classId: DECAL_CLASS_ID, properties: { materialGuid: "stain" } }]));
      upsertDecals(scene, "mirrored", mirrored, decalBindings([{ id: "d", classId: DECAL_CLASS_ID, properties: { materialGuid: "glow", sortOrder: 1 } }]));
      const uploads = await drawDecals(scene, camera);
      expect(sceneDecalHost(scene).currentBatches.map((batch) => batch.mirrored)).toEqual([false, true]);
      const drawn = uploads.events.filter((event) => event.startsWith("cull") || event.startsWith("draw") || event === `alpha:${Constants.ALPHA_MULTIPLY}` || event === `alpha:${Constants.ALPHA_ADD}`);
      expect(drawn.slice(0, 6)).toEqual(["cull:ccw", `alpha:${Constants.ALPHA_MULTIPLY}`, "draw:1", "cull:cw", `alpha:${Constants.ALPHA_ADD}`, "draw:1"]);
    });

    it("never draws a decal whose Material's program is not ready: it is skipped, and the view is asked to draw again", async () => {
      const scene = testScene();
      const material = await compiledDecal(scene);
      setDecalMaterialSource(scene, { resolve: () => material });
      const pending = vi.fn();
      setDecalPendingListener(scene, pending);
      const camera = cameraAt(scene);
      spawnAt(scene, "impact");
      vi.spyOn(material, "isReadyForSubMesh").mockReturnValue(false);
      const uploads = await drawDecals(scene, camera);
      expect(uploads.events.filter((event) => event.startsWith("draw"))).toEqual([]);
      expect(sceneDecalsPending(scene)).toBe(true);
      expect(sceneDecalStats(scene).pending).toBe(1);
      expect(pending).toHaveBeenCalled();
    });

    it("warms a Decal Material on the pass's own box, keeps the pass, and draws it once, covering nothing, before any decal", async () => {
      const scene = testScene();
      const material = await compiledDecal(scene);
      const other = stubDecalMaterial(scene, "surface", "surface");
      setDecalMaterialSource(scene, { resolve: () => material });
      expect(sceneHasDecals(scene)).toBe(false);
      // Only Decal Materials warm here.
      expect(await warmDecalMaterials(scene, [material, other])).toBe(1);
      expect(sceneHasDecals(scene)).toBe(true);
      const camera = cameraAt(scene);
      const first = await drawDecals(scene, camera);
      expect(first.events.filter((event) => event.startsWith("draw"))).toEqual(["draw:1"]);
      // A zero world collapses the box to a point.
      expect(first.rows.matrix!.slice(0, 16).every((value) => value === 0)).toBe(true);
      vi.restoreAllMocks();
      const second = await drawDecals(scene, camera);
      expect(second.events.filter((event) => event.startsWith("draw"))).toEqual([]);
    });
  });
});
