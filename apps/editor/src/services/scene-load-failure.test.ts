import { expect, it, vi } from "vitest";
import { createActor, createDefaultScene } from "@babylonslate/core";
import { createInProcessRuntime } from "@babylonslate/runtime";
import { createSceneLoadReadiness, type SceneLoadProgress } from "@babylonslate/render";

it("reports an invalid circle at the 20% realization phase and releases the stopped host", async () => {
  const scene = createDefaultScene("2d");
  scene.actors = [createActor("invalid-circle", "Invalid Circle", {
    components: [{ id: "circle-collider", classId: "ColliderComponent", properties: { shape: { kind: "circle", radius: 0 } } }],
  })];
  const states: Array<SceneLoadProgress | null> = [];
  const release = vi.fn();
  const failed = vi.fn();
  const ready = vi.fn();
  const readiness = createSceneLoadReadiness({
    handle: { whenEditorModelsReady: async () => {}, whenMaterialTexturesReady: async () => {},
      prewarmSceneMaterials: async () => {}, presentFirstFrame: async () => {} },
    loading: { acquire: () => release, progress: (state) => states.push(state),
      paint: async () => {}, painted: ({ sceneAssetGuid, sceneLoadId }) => runtime.notifySceneLoadingPainted(sceneAssetGuid, sceneLoadId) },
    activate: () => {}, onReady: ready,
    onFailed: (identity, error) => {
      failed(identity, error);
      queueMicrotask(() => { runtime.stop(); readiness.dispose(); });
    },
  });
  const runtime = createInProcessRuntime({
    playScene: scene, playSceneGuid: "invalid-circle-scene", seedDemoActors: false,
    physicsWorld: "2d", preferSoftwarePhysics: true, cooperativeSceneLoading: true,
    deferSceneLoadingPaint: true, onCommand: (command) => readiness.receive(command),
  });
  try {
    await expect(runtime.realizePlayWorld()).rejects.toThrow();
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(states).toContainEqual(expect.objectContaining({ progress: 20, phase: "Realizing Scene" }));
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ sceneAssetGuid: "invalid-circle-scene" }),
      expect.objectContaining({ message: expect.stringMatching(/positive/) }));
    expect(ready).not.toHaveBeenCalled();
    expect(states.at(-1)).toBeNull();
  } finally { runtime.stop(); readiness.dispose(); }
});

