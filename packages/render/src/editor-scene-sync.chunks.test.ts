import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  normalizeShadowSettings,
  type SerializedScene,
} from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import { EditorSceneSync, type EditorSceneSyncOptions } from "./editor-scene-sync";
import { DirectionalLight, StandardMaterial } from "@babylonjs/core";
import { sceneShadowController } from "./shadow-controller";
import { updateSceneRenderingSettings } from "./render-settings";
import { createEditorCamera } from "./editor-camera";
import { encodeParentedAnimatedTriangleGlb, encodeTriangleGlb } from "./model-mesh";
import { visualMeshes } from "./visual-meshes";
import * as modelContainer from "./model-container";
import * as modelLoads from "./glb-anim";

const handles: ReturnType<typeof createTestEngine>[] = [];
const releaseLoads: Array<() => void> = [];
afterEach(() => {
  for (const release of releaseLoads.splice(0)) release();
  vi.restoreAllMocks();
  for (const { scene, engine } of handles.splice(0)) {
    scene.dispose();
    engine.dispose();
  }
});
function holdModelContainer(name?: string) {
  const load = modelContainer.loadModelContainer;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  releaseLoads.push(release);
  let loaded!: (container: Awaited<ReturnType<typeof load>>) => void;
  const ready = new Promise<Awaited<ReturnType<typeof load>>>((resolve) => { loaded = resolve; });
  vi.spyOn(modelContainer, "loadModelContainer").mockImplementation(async (...args) => {
    const container = await load(...args);
    if (name && args[2] !== name) return container;
    loaded(container);
    await gate;
    return container;
  });
  return { ready, release };
}
function fixture(options: EditorSceneSyncOptions = {}) {
  const handle = createTestEngine();
  handles.push(handle);
  createEditorCamera(handle.scene, { mode: "3d" });
  const onAfterApply = vi.fn();
  return {
    ...handle,
    onAfterApply,
    sync: new EditorSceneSync(handle.scene, undefined, { ...options, onAfterApply }),
  };
}
function document(count = 80): SerializedScene {
  return {
    ...createDefaultScene(),
    actors: Array.from({ length: count }, (_, index) =>
      createActor(`actor-${index}`, `Actor ${index}`, {
        components: [createMeshComponent(`mesh-${index}`, "box")],
      }),
    ),
  };
}

describe("cooperative editor realization", () => {
  it.each(["abort", "replace", "dispose"] as const)("discards a deferred material refresh after %s", async (action) => {
    let resolve = () => null as StandardMaterial | null;
    const { sync, scene, onAfterApply } = fixture({ resolveMaterial: () => resolve() });
    const first = new StandardMaterial("First", scene);
    const nextMaterial = new StandardMaterial("Next", scene);
    resolve = () => first;
    const next = document();
    for (const actor of next.actors) actor.components[0]!.properties.materialGuid = "surface";
    const previous = { ...next, actors: next.actors.slice(0, 1) };
    sync.apply(previous);
    const root = sync.meshForActor("actor-0")!;
    onAfterApply.mockClear();
    const controller = new AbortController();
    const failure = new Error("Material owner cancelled");
    let acted = false;
    const applying = sync.applyAsync(next, {
      signal: controller.signal,
      yieldControl: async () => {
        if (acted || sync.actorCount() < 2) return;
        acted = true;
        resolve = () => nextMaterial;
        sync.refreshMaterials();
        expect(root.material).toBe(first);
        if (action === "abort") controller.abort(failure);
        else if (action === "replace") sync.apply(document(0));
        else sync.dispose();
      },
    });
    await expect(applying).rejects.toThrow(action === "abort" ? failure.message : action === "replace" ? "superseded" : "disposed");
    expect(acted).toBe(true);
    const callsAtCancellation = onAfterApply.mock.calls.length;
    sync.refreshMaterials();
    expect(onAfterApply).toHaveBeenCalledTimes(callsAtCancellation + (action === "replace" ? 1 : 0));
    if (action === "abort") {
      expect(root.material).toBe(first);
      expect(sync.serializedScene()).toBe(previous);
      await expect(sync.whenEditorModelsReady()).rejects.toBe(failure);
    } else {
      expect(root.isDisposed()).toBe(true);
      expect(sync.actorCount()).toBe(0);
    }
  });

  it("keeps model adoption and its readiness pending when material bindings refresh", async () => {
    const { sync } = fixture();
    const next = document(1);
    next.actors[0]!.components[0]!.properties.assetGuid = "model";
    const delayed = holdModelContainer();
    const requests = vi.spyOn(modelLoads, "beginSlotModelAnimLoad");
    sync.setMeshAssets({ modelBytes: new Map([["model", encodeTriangleGlb()]]) });
    sync.apply(next);
    await delayed.ready;
    const root = sync.meshForActor("actor-0")!;
    sync.refreshMaterials();
    let ready = false;
    const readiness = sync.whenEditorModelsReady().then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);
    expect(requests).toHaveBeenCalledOnce();
    delayed.release();
    await readiness;
    expect(sync.meshForActor("actor-0")).toBe(root);
    expect(visualMeshes(root).some((mesh) => mesh.getTotalVertices() === 3)).toBe(true);
  });

  it("yields during actor and light creation and commits only after all phases", async () => {
    const { sync, scene, onAfterApply } = fixture();
    const next = document();
    for (const actor of next.actors)
      actor.components.push({
        id: `${actor.id}-light`,
        classId: "LightComponent",
        properties: { kind: "point", castShadows: false },
      });
    const partial: Array<{ actors: number; lights: number }> = [];
    const progress: number[] = [];
    await sync.applyAsync(next, {
      signal: new AbortController().signal,
      onProgress: (value) => progress.push(value),
      yieldControl: async () => {
        expect(sync.serializedScene()).toBeNull();
        expect(onAfterApply).not.toHaveBeenCalled();
        expect(scene._activeMeshesFrozen).toBe(false);
        partial.push({
          actors: sync.actorCount(),
          lights: scene.lights.length,
        });
      },
    });
    expect(partial.some((entry) => entry.actors > 0 && entry.actors < 80)).toBe(
      true,
    );
    expect(partial.some((entry) => entry.lights > 0 && entry.lights < 80)).toBe(
      true,
    );
    expect(
      progress.every(
        (value, index) =>
          value >= 0 &&
          value <= 1 &&
          (index === 0 || value >= progress[index - 1]!),
      ),
    ).toBe(true);
    expect(sync.serializedScene()).toBe(next);
    expect(sync.actorCount()).toBe(80);
    expect(onAfterApply).toHaveBeenCalledOnce();
  });

  it("keeps model readiness pending until the final actor has been submitted", async () => {
    const { sync } = fixture();
    let resume!: () => void;
    let held = false;
    const applying = sync.applyAsync(document(), {
      signal: new AbortController().signal,
      yieldControl: async () => {
        if (!held) {
          held = true;
          await new Promise<void>((resolve) => {
            resume = resolve;
          });
        }
      },
    });
    let ready = false;
    const readiness = sync.whenEditorModelsReady().then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    resume();
    await applying;
    await readiness;
    expect(sync.actorCount()).toBe(80);
    expect(ready).toBe(true);
  });

  it.each(["sync", "async"] as const)(
    "preserves a child when %s reconciliation replaces or removes its parent",
    async (mode) => {
      const { sync } = fixture();
      const parent = createActor("parent", "Parent", {
        components: [createMeshComponent("parent-mesh", "box")],
      });
      const child = createActor("child", "Child", {
        parentId: parent.id,
        components: [createMeshComponent("child-mesh", "box")],
      });
      const apply = async (actors: SerializedScene["actors"]) => {
        const next = { ...createDefaultScene(), actors };
        if (mode === "async")
          await sync.applyAsync(next, { signal: new AbortController().signal });
        else sync.apply(next);
      };
      await apply([child, parent]);
      const childRoot = sync.meshForActor(child.id)!;
      expect(childRoot.parent).toBe(sync.meshForActor(parent.id));
      await apply([
        child,
        {
          ...parent,
          components: [createMeshComponent("parent-mesh", "sphere")],
        },
      ]);
      expect(sync.meshForActor(child.id)).toBe(childRoot);
      expect(childRoot.isDisposed()).toBe(false);
      expect(childRoot.parent).toBe(sync.meshForActor(parent.id));
      await apply([{ ...child, parentId: null }]);
      expect(childRoot.isDisposed()).toBe(false);
      expect(childRoot.parent).toBeNull();
      expect(sync.meshForActor(parent.id)).toBeNull();
    },
  );

  it("aborts partially realized actors without committing and reconciles the next document", async () => {
    const { sync, onAfterApply } = fixture();
    const controller = new AbortController();
    const failure = new Error("replacement requested");
    await expect(
      sync.applyAsync(document(), {
        signal: controller.signal,
        yieldControl: async () => {
          if (sync.actorCount() > 0) controller.abort(failure);
        },
      }),
    ).rejects.toBe(failure);
    expect(sync.actorCount()).toBeGreaterThan(0);
    expect(sync.serializedScene()).toBeNull();
    expect(onAfterApply).not.toHaveBeenCalled();
    await expect(sync.whenEditorModelsReady()).rejects.toBe(failure);
    const next = document(1);
    sync.apply(next);
    expect(sync.actorCount()).toBe(1);
    expect(sync.meshForActor("actor-0")?.isDisposed()).toBe(false);
    expect(sync.serializedScene()).toBe(next);
  });

  it("does not reuse successful readiness for an already-cancelled replacement", async () => {
    const { sync, onAfterApply } = fixture();
    const previous = document(1);
    sync.apply(previous);
    const root = sync.meshForActor("actor-0");
    const controller = new AbortController();
    const failure = new Error("cancelled before realization");
    controller.abort(failure);
    await expect(
      sync.applyAsync(document(), { signal: controller.signal }),
    ).rejects.toBe(failure);
    await expect(sync.whenEditorModelsReady()).rejects.toBe(failure);
    expect(sync.serializedScene()).toBe(previous);
    expect(sync.meshForActor("actor-0")).toBe(root);
    expect(sync.actorCount()).toBe(1);
    expect(onAfterApply).toHaveBeenCalledOnce();
  });

  it("does not resume an obsolete chunk after an immediate scene replacement", async () => {
    const { sync, onAfterApply } = fixture();
    let resume!: () => void;
    const old = sync.applyAsync(document(), {
      signal: new AbortController().signal,
      yieldControl: () =>
        new Promise<void>((resolve) => {
          resume = resolve;
        }),
    });
    const rejected = expect(old).rejects.toThrow("superseded");
    await vi.waitFor(() => expect(resume).toBeTypeOf("function"));
    const next = document(1);
    sync.apply(next);
    resume();
    await rejected;
    expect(sync.serializedScene()).toBe(next);
    expect(sync.actorCount()).toBe(1);
    expect(onAfterApply).toHaveBeenCalledOnce();
  });

  it.each(["before", "after"] as const)("lets a replacement %s model completion reuse the container without cancelled adoption", async (replace) => {
    const { sync, scene, onAfterApply } = fixture();
    sync.apply(document(1));
    const previousRoot = sync.meshForActor("actor-0");
    onAfterApply.mockClear();
    const next = document();
    next.actors[0]!.components[0]!.properties.assetGuid = "model";
    const delayed = holdModelContainer();
    const requests = vi.spyOn(modelLoads, "beginSlotModelAnimLoad");
    const controller = new AbortController();
    const failure = new Error("cancelled while the model was loading");
    await expect(sync.applyAsync(next, {
      signal: controller.signal,
      assets: { modelBytes: new Map([["model", encodeTriangleGlb()]]) },
      yieldControl: async () => {
        await delayed.ready;
        controller.abort(failure);
      },
    })).rejects.toBe(failure);
    const root = sync.meshForActor("actor-0")!;
    const container = await delayed.ready;
    const instantiate = vi.spyOn(container, "instantiateModelsToScene");
    await expect(sync.whenEditorModelsReady()).rejects.toBe(failure);
    if (replace === "before") {
      await sync.applyAsync(next, { signal: new AbortController().signal });
      expect(onAfterApply).toHaveBeenCalledOnce();
    }
    delayed.release();
    await Promise.all(requests.mock.results.map((result) => result.value));
    if (replace === "after") {
      expect(instantiate).not.toHaveBeenCalled();
      expect(root).toBe(previousRoot);
      expect(root.isDisposed()).toBe(false);
      expect(onAfterApply).not.toHaveBeenCalled();
      expect(scene._activeMeshesFrozen).toBe(false);
      await expect(sync.whenEditorModelsReady()).rejects.toBe(failure);
      await sync.applyAsync(next, { signal: new AbortController().signal });
    }
    await sync.whenEditorModelsReady();
    const adopted = sync.meshForActor("actor-0")!;
    expect(adopted).not.toBe(root);
    expect(root.isDisposed()).toBe(true);
    expect(instantiate).toHaveBeenCalledOnce();
    expect(modelLoads.glbContainerLoadCount(scene)).toBe(1);
    expect(visualMeshes(adopted).some((mesh) => mesh.getTotalVertices() === 3)).toBe(true);
  });

  it.each(["sync", "async"] as const)("keeps %s replacement readiness independent of an obsolete unresolved model", async (mode) => {
    const { sync } = fixture();
    const next = document(1);
    next.actors[0]!.components[0]!.properties.assetGuid = "model";
    const delayed = holdModelContainer();
    const requests = vi.spyOn(modelLoads, "beginSlotModelAnimLoad");
    sync.setMeshAssets({ modelBytes: new Map([["model", encodeTriangleGlb()]]) });
    sync.apply(next);
    await delayed.ready;
    const replacement = document(0);
    if (mode === "async") await sync.applyAsync(replacement, { signal: new AbortController().signal });
    else sync.apply(replacement);
    let ready = false;
    const readiness = sync.whenEditorModelsReady().then(() => { ready = true; });
    await vi.waitFor(() => expect(ready).toBe(true));
    expect(sync.pendingModelLoadCount()).toBe(0);
    delayed.release();
    await requests.mock.results[0]!.value;
    await readiness;
    expect(sync.actorCount()).toBe(0);
    expect(sync.serializedScene()).toBe(replacement);
  });

  it("waits for retarget sources when replacing a model whose hierarchy was already instantiated", async () => {
    const { sync, scene } = fixture();
    const next = document(1);
    next.actors[0]!.components[0]!.properties.assetGuid = "model";
    const delayed = holdModelContainer("retarget-source.glb");
    const bytes = encodeParentedAnimatedTriangleGlb();
    sync.setMeshAssets({
      modelBytes: new Map([["model", bytes], ["retarget-source", bytes]]),
      retargetAnimationLoads: new Map([["model", [{
        animationGuid: "retargeted-idle",
        clipName: "Idle",
        sourceModelGuid: "retarget-source",
      }]]]),
    });
    sync.apply(next);
    await delayed.ready;
    const root = sync.meshForActor("actor-0")!;
    expect(visualMeshes(root).some((mesh) => mesh.getTotalVertices() === 3)).toBe(false);
    await sync.applyAsync(next, { signal: new AbortController().signal });
    expect(sync.meshForActor("actor-0")).toBe(root);
    let ready = false;
    const readiness = sync.whenEditorModelsReady().then(() => { ready = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ready).toBe(false);
    delayed.release();
    await readiness;
    expect(ready).toBe(true);
    expect(visualMeshes(sync.meshForActor("actor-0")!).some((mesh) => mesh.getTotalVertices() === 3)).toBe(true);
    expect(modelLoads.glbContainerLoadCount(scene)).toBe(2);
  });

  it("restores a static actor matrix when its model lands during the final freeze phase", async () => {
    const { sync, onAfterApply } = fixture();
    const next = document();
    next.actors[0]!.components[0]!.properties.assetGuid = "model";
    const delayed = holdModelContainer();
    const requests = vi.spyOn(modelLoads, "beginSlotModelAnimLoad");
    let progress = 0;
    let released = false;
    await sync.applyAsync(next, {
      signal: new AbortController().signal,
      assets: { modelBytes: new Map([["model", encodeTriangleGlb()]]) },
      onProgress: (value) => { progress = value; },
      yieldControl: async () => {
        if (progress < 0.95 || released) return;
        released = true;
        const root = sync.meshForActor("actor-0")!;
        expect(root.isWorldMatrixFrozen).toBe(true);
        await delayed.ready;
        delayed.release();
        await requests.mock.results[0]!.value;
        expect(root.isWorldMatrixFrozen).toBe(true);
        expect(onAfterApply).not.toHaveBeenCalled();
      },
    });
    expect(released).toBe(true);
    expect(sync.meshForActor("actor-0")!.isWorldMatrixFrozen).toBe(true);
    expect(onAfterApply).toHaveBeenCalledOnce();
  });

  it("defers GLB callbacks from freezing or announcing a partially realized scene", async () => {
    const { sync, scene, onAfterApply } = fixture();
    const next = document();
    next.actors[0]!.components[0]!.properties.assetGuid = "model";
    let resume!: () => void;
    let held = false;
    const old = sync.applyAsync(next, {
      signal: new AbortController().signal,
      assets: { modelBytes: new Map([["model", encodeTriangleGlb()]]) },
      yieldControl: async () => {
        if (!held && sync.meshForActor("actor-0")) {
          held = true;
          await new Promise<void>((resolve) => {
            resume = resolve;
          });
        }
      },
    });
    const rejected = expect(old).rejects.toThrow("superseded");
    await vi.waitFor(() => expect(held).toBe(true));
    const root = sync.meshForActor("actor-0")!;
    await vi.waitFor(() =>
      expect(
        visualMeshes(root).some((mesh) => mesh.getTotalVertices() === 3),
      ).toBe(true),
    );
    expect(onAfterApply).not.toHaveBeenCalled();
    expect(scene._activeMeshesFrozen).toBe(false);
    sync.apply({ ...createDefaultScene(), actors: [] });
    resume();
    await rejected;
    expect(root.isDisposed()).toBe(true);
    expect(sync.actorCount()).toBe(0);
    expect(onAfterApply).toHaveBeenCalledOnce();
  });
});

describe("mesh shadow participation through the editor apply path", () => {
  it("excludes a castShadows:false primitive from the generator renderList", async () => {
    const { sync, scene } = fixture();
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({ cascades: 1 }),
    });
    const controller = sceneShadowController(scene);
    const doc = createDefaultScene();
    const caster = createActor("caster", "Caster", {
      components: [createMeshComponent("caster-mesh", "box")],
    });
    const nonCasterComponent = createMeshComponent("nc-mesh", "sphere");
    nonCasterComponent.properties.castShadows = false;
    const nonCaster = createActor("non-caster", "Non Caster", {
      transform: { position: [3, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      components: [nonCasterComponent],
    });
    doc.actors = [...doc.actors, caster, nonCaster];
    sync.apply(doc);
    const light = scene.lights.find((entry) => entry instanceof DirectionalLight)!;
    // Babylon defers onNewMeshAdded via a macrotask; flush it so the
    // controller's pending set is populated the way the render loop does.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    controller.sync();
    const renderList = controller.generator(light)?.getShadowMap()?.renderList ?? [];
    const casterMesh = sync.meshForActor("caster")!;
    const nonCasterMesh = sync.meshForActor("non-caster")!;
    expect(renderList).toContain(casterMesh);
    expect(renderList).not.toContain(nonCasterMesh);
    expect(nonCasterMesh.receiveShadows).toBe(true);
  });
});
