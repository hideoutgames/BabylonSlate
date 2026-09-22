import { FreeCamera, NullEngine, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";
import { SNAPSHOT_FLAG_OVERLAY, SNAPSHOT_FLAG_VISIBLE } from "@babylonslate/bridge";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prewarmSceneMaterials } from "./scene-perf";
import { SceneRenderCoordinator } from "./scene-render-coordinator";
import {
  applySnapshotToScene,
  createSnapshotSceneBinding,
} from "./snapshot-apply";
import type { SampledSnapshot } from "./snapshot-sync";

const handles: Array<{ engine: NullEngine; scene: Scene }> = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const { scene, engine } of handles.splice(0)) {
    scene.dispose();
    engine.dispose();
  }
});

function fixture(actorCount: number) {
  // Keep this fixture's stable material texture-free: NullEngine cannot upload
  // the editor default checker texture and would strand strict readiness.
  const engine = new NullEngine();
  const handle = { engine, scene: new Scene(engine) };
  handles.push(handle);
  const { scene } = handle;
  scene.activeCamera = new FreeCamera("snapshot-camera", new Vector3(0, 0, -40), scene);
  const binding = createSnapshotSceneBinding();
  const snapshot: SampledSnapshot = {
    frameId: 1,
    tickIndex: 1,
    alpha: 1,
    actorCount,
    actors: Array.from({ length: actorCount }, (_, slotId) => {
      binding.meshKinds.set(slotId, "box");
      return {
        slotId,
        position: { x: slotId % 16, y: Math.floor(slotId / 16), z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
        flags: SNAPSHOT_FLAG_VISIBLE,
      };
    }),
  };
  return { ...handle, binding, snapshot };
}

function distribution(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1]!;
  return {
    samples: sorted.length,
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
  };
}

describe("snapshot synchronization native work", () => {
  it("keeps warmed identical, new-frame and moving samples free of global dirty and bulk cleanup calls", async () => {
    const { scene, binding, snapshot } = fixture(256);
    applySnapshotToScene(scene, binding, snapshot);
    await prewarmSceneMaterials(scene);
    for (let frame = 0; frame < 3; frame += 1) scene.render();
    const originalMeshes = [...binding.meshes.values()];
    const originalMaterials = [...scene.materials];
    const dirty = vi.spyOn(scene, "markAllMaterialsAsDirty");
    const activeCleanup = vi.spyOn(scene, "freeActiveMeshes");
    const groupCleanup = vi.spyOn(scene, "freeRenderingGroups");
    const results = [];

    for (const phase of ["identical", "new-frame", "moving"] as const) {
      dirty.mockClear();
      activeCleanup.mockClear();
      groupCleanup.mockClear();
      const durations: number[] = [];
      for (let frame = 0; frame < 120; frame += 1) {
        if (phase !== "identical") {
          snapshot.frameId += 1;
          snapshot.tickIndex += 1;
        }
        if (phase === "moving") {
          for (const actor of snapshot.actors) {
            actor.position.x = actor.slotId % 16 + frame / 10;
            actor.rotation.y = Math.sin(frame / 200);
            actor.rotation.w = Math.cos(frame / 200);
          }
        }
        // Deliberately bypass caller deduplication. Render-loop queue resets,
        // fixture mutation and timing summaries are outside this attribution.
        const started = performance.now();
        applySnapshotToScene(scene, binding, snapshot);
        durations.push(performance.now() - started);
      }
      results.push({
        phase,
        actors: snapshot.actorCount,
        ...distribution(durations),
        globalMaterialDirty: dirty.mock.calls.length,
        activeMeshCleanup: activeCleanup.mock.calls.length,
        renderingGroupCleanup: groupCleanup.mock.calls.length,
      });
    }
    // Same fixture reports before/after distributions; only attributable work
    // is an acceptance threshold, since elapsed CPU time varies by machine.
    console.info("snapshot preparation measurements", JSON.stringify(results));
    expect(results.map(({ phase, globalMaterialDirty, activeMeshCleanup, renderingGroupCleanup }) => ({
      phase, globalMaterialDirty, activeMeshCleanup, renderingGroupCleanup,
    }))).toEqual([
      { phase: "identical", globalMaterialDirty: 0, activeMeshCleanup: 0, renderingGroupCleanup: 0 },
      { phase: "new-frame", globalMaterialDirty: 0, activeMeshCleanup: 0, renderingGroupCleanup: 0 },
      { phase: "moving", globalMaterialDirty: 0, activeMeshCleanup: 0, renderingGroupCleanup: 0 },
    ]);
    expect([...binding.meshes.values()]).toEqual(originalMeshes);
    expect(scene.materials).toEqual(originalMaterials);
    const first = binding.meshes.get(0)!;
    expect(first.position.x).toBeCloseTo(11.9);
    expect(first.rotationQuaternion?.y).toBeCloseTo(Math.sin(119 / 200));
    expect(first.getWorldMatrix().getTranslation().x).toBeCloseTo(11.9);
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])("leaves caller material=%s and cleanup=%s flags untouched on publication and failure", (materialFlag, cleanupFlag) => {
    const { scene, binding, snapshot } = fixture(1);
    scene.blockMaterialDirtyMechanism = materialFlag;
    scene.blockfreeActiveMeshesAndRenderingGroups = cleanupFlag;
    const materialSetter = vi.spyOn(scene, "blockMaterialDirtyMechanism", "set");
    const cleanupSetter = vi.spyOn(scene, "blockfreeActiveMeshesAndRenderingGroups", "set");
    applySnapshotToScene(scene, binding, snapshot);
    expect(binding.meshes.get(0)?.isDisposed()).toBe(false);
    expect(scene.blockMaterialDirtyMechanism).toBe(materialFlag);
    expect(scene.blockfreeActiveMeshesAndRenderingGroups).toBe(cleanupFlag);

    // Scene ownership resolution belongs to structural reconciliation and may
    // fail before a missing visual can be constructed.
    binding.sceneForSlot = () => { throw new Error("injected scene ownership failure"); };
    snapshot.actors[0]!.slotId = 1;
    expect(() => applySnapshotToScene(scene, binding, snapshot)).toThrow("injected scene ownership failure");
    expect(scene.blockMaterialDirtyMechanism).toBe(materialFlag);
    expect(scene.blockfreeActiveMeshesAndRenderingGroups).toBe(cleanupFlag);
    expect(materialSetter).not.toHaveBeenCalled();
    expect(cleanupSetter).not.toHaveBeenCalled();
  });

  it("keeps settled transform frames out of strict readiness while publishing and retiring geometry invalidate it", async () => {
    const { scene, engine, binding, snapshot } = fixture(8);
    // Match the existing coordinator fixture's NullEngine MRT driver boundary;
    // scene readiness, graph tasks, meshes, materials and rendering remain real.
    vi.spyOn(engine, "buildTextureLayout").mockImplementation((enabled, backbuffer) =>
      backbuffer ? [0x0405] : enabled.map((value, index) => value ? 0x8ce0 + index : 0));
    vi.spyOn(engine, "bindAttachments").mockImplementation(() => {});
    vi.spyOn(engine, "restoreSingleAttachment").mockImplementation(() => {});
    vi.spyOn(engine, "restoreSingleAttachmentForRenderTarget").mockImplementation(() => {});
    const renderer = new SceneRenderCoordinator(scene);
    try {
      applySnapshotToScene(scene, binding, snapshot);
      await renderer.prepare();
      expect(renderer.render()).toMatchObject({ path: "frameGraph", readyForPresentation: true });

      const moveFrames = () => {
        const checks = renderer.strictReadinessChecks;
        for (let frame = 0; frame < 20; frame += 1) {
          snapshot.frameId += 1;
          snapshot.actors[0]!.position.x += 0.25;
          applySnapshotToScene(scene, binding, snapshot);
          expect(renderer.isReady()).toBe(true);
          expect(renderer.render()).toMatchObject({ path: "frameGraph", readyForPresentation: true });
        }
        expect(renderer.strictReadinessChecks).toBe(checks);
      };
      moveFrames();

      const beforeCreation = renderer.strictReadinessChecks;
      snapshot.actors.push({
        slotId: 8,
        position: { x: 0, y: 0, z: 2 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
        flags: SNAPSHOT_FLAG_VISIBLE,
      });
      snapshot.actorCount += 1;
      binding.meshKinds.set(8, "box");
      applySnapshotToScene(scene, binding, snapshot);
      expect(renderer.readinessDirty).toBe(true);
      await renderer.prepare();
      expect(renderer.strictReadinessChecks).toBeGreaterThan(beforeCreation);
      expect(renderer.render()).toMatchObject({ path: "frameGraph", readyForPresentation: true });
      moveFrames();

      const beforeRemoval = renderer.strictReadinessChecks;
      const retired = binding.meshes.get(8)!;
      snapshot.actors.pop();
      snapshot.actorCount -= 1;
      applySnapshotToScene(scene, binding, snapshot);
      expect(retired.isDisposed()).toBe(true);
      expect(renderer.readinessDirty).toBe(true);
      await renderer.prepare();
      expect(renderer.strictReadinessChecks).toBeGreaterThan(beforeRemoval);
      expect(renderer.render()).toMatchObject({ path: "frameGraph", readyForPresentation: true });
      moveFrames();
    } finally {
      await renderer.retire();
    }
  });

  it("reconciles both SceneLayer migration directions using the actual material owner", () => {
    const { scene, engine, binding, snapshot } = fixture(1);
    const layer = new Scene(engine);
    const worldMaterial = new StandardMaterial("world", scene);
    const layerMaterial = new StandardMaterial("layer", layer);
    binding.materialAssetGuids.set(0, "surface");
    binding.resolveMaterial = (_guid, options) => options?.scene === layer ? layerMaterial : worldMaterial;
    applySnapshotToScene(scene, binding, snapshot);
    const original = binding.meshes.get(0)!;
    expect(original.material).toBe(worldMaterial);

    binding.sceneForSlot = () => layer;
    snapshot.actors[0]!.flags |= SNAPSHOT_FLAG_OVERLAY;
    applySnapshotToScene(scene, binding, snapshot);
    const overlay = binding.meshes.get(0)!;
    expect(original.isDisposed()).toBe(true);
    expect(overlay.getScene()).toBe(layer);
    expect(overlay.material).toBe(layerMaterial);

    binding.sceneForSlot = () => null;
    snapshot.actors[0]!.flags = SNAPSHOT_FLAG_VISIBLE;
    applySnapshotToScene(scene, binding, snapshot);
    expect(overlay.isDisposed()).toBe(true);
    expect(binding.meshes.get(0)!.getScene()).toBe(scene);
    expect(binding.meshes.get(0)!.material).toBe(worldMaterial);
    expect(layer.meshes).toHaveLength(0);
  });
});
