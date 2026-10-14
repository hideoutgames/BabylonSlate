import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  normalizeShadowSettings,
  type SerializedActor,
  type SerializedScene,
} from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import { EditorSceneSync, type EditorSceneSyncOptions } from "./editor-scene-sync";
import { DirectionalLight, Mesh, StandardMaterial } from "@babylonjs/core";
import { sceneShadowController } from "./shadow-controller";
import { updateSceneRenderingSettings } from "./render-settings";
import { createEditorCamera } from "./editor-camera";
import { encodeParentedAnimatedTriangleGlb, encodeTriangleGlb } from "./glb-test-fixtures";
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
/** These tests observe partially realized state at each yield, so they ask for small chunks. */
const fine = { stepsPerYield: 32 };
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

it("enumerates an attached sprite as its own authored visual boundary without broadening asset consumers", () => {
  const { sync, scene } = fixture();
  const data = createDefaultScene();
  const actor = createActor("parent", "Parent", { components: [
    createMeshComponent("body", "box"),
    { id: "sprite", classId: "SpriteComponent", parentId: "body", properties: {} },
  ] });
  data.actors = [actor, createActor("child", "Child", { parentId: "parent", components: [createMeshComponent("child-body", "box")] })];
  sync.apply(data);
  const body = sync.meshForComponent("parent", "body")!;
  const sprite = scene.getMeshByName("editorActor:parent|sprite")!;
  expect(sprite.parent).toBe(body);
  const imported = new Mesh("Imported Part", scene); imported.parent = body;
  expect(sync.visualComponentRootsForActor("parent")).toEqual([body, sprite]);
  expect(sync.visualComponentRootsForActor("child")).toEqual([sync.meshForActor("child")]);
  expect(sync.visualComponentRootsForActor("missing")).toEqual([]);
  expect(sync.meshForComponent("parent", "sprite")).toBeNull();
  actor.components = [actor.components[0]!];
  sync.apply(data);
  expect(sync.visualComponentRootsForActor("parent")).toEqual([sync.meshForComponent("parent", "body")]);
  expect(sprite.isDisposed()).toBe(true);
  sync.dispose();
});

it("resolves component visuals from the latest applied Scene even when its actor list was edited in place", () => {
  const { sync } = fixture();
  const data = document(2);
  sync.apply(data);
  expect(sync.meshForComponent("actor-1", "mesh-1")).not.toBeNull();
  expect(sync.meshForComponent("actor-1", "replaced")).toBeNull();
  data.actors[1] = createActor("actor-1", "Actor 1", { components: [createMeshComponent("replaced", "sphere")] });
  sync.apply(data);
  expect(sync.meshForComponent("actor-1", "mesh-1")).toBeNull();
  expect(sync.meshForComponent("actor-1", "replaced")).not.toBeNull();
});

it("refreshes at once for the first Material publication and shares one more pass among those that settle in the same turn", async () => {
  let current: StandardMaterial | null = null;
  const resolveMaterial = vi.fn(() => current);
  const { sync, scene, onAfterApply } = fixture({ resolveMaterial });
  const data = document(3);
  for (const actor of data.actors) actor.components[0]!.properties.materialGuid = "surface";
  sync.apply(data);
  const first = new StandardMaterial("First", scene);
  const last = new StandardMaterial("Last", scene);
  const bound = () => data.actors.map((actor) => sync.meshForActor(actor.id)!.material);
  onAfterApply.mockClear();
  resolveMaterial.mockClear();

  current = first;
  sync.refreshMaterialsCoalesced();
  expect(bound()).toEqual([first, first, first]);
  expect(onAfterApply).toHaveBeenCalledTimes(1);
  expect(resolveMaterial).toHaveBeenCalledTimes(3);

  current = last;
  sync.refreshMaterialsCoalesced();
  sync.refreshMaterialsCoalesced();
  expect(onAfterApply).toHaveBeenCalledTimes(1);
  await Promise.resolve();
  expect(bound()).toEqual([last, last, last]);
  expect(onAfterApply).toHaveBeenCalledTimes(2);
  expect(resolveMaterial).toHaveBeenCalledTimes(6);

  // The next publication after the turn is a leading one again.
  current = first;
  sync.refreshMaterialsCoalesced();
  expect(bound()).toEqual([first, first, first]);
  await Promise.resolve();
  expect(onAfterApply).toHaveBeenCalledTimes(3);
});

describe("a Material publication that names its Material", () => {
  /** One box per entry, bound to that Material guid (none for `null`). */
  function boxesUsing(guids: Array<string | null>): SerializedScene {
    const data = document(guids.length);
    guids.forEach((guid, index) => {
      if (guid) data.actors[index]!.components[0]!.properties.materialGuid = guid;
    });
    return data;
  }
  function resolver() {
    const materials = new Map<string, StandardMaterial>();
    const resolveMaterial = vi.fn<(guid: string, options?: unknown) => StandardMaterial | null>((guid) => materials.get(guid) ?? null);
    const asked = () => resolveMaterial.mock.calls.map(([guid]) => guid);
    return { materials, resolveMaterial, asked };
  }

  it("rebinds only the actors that resolved it", () => {
    const { materials, resolveMaterial, asked } = resolver();
    const { sync, scene, onAfterApply } = fixture({ resolveMaterial });
    const data = boxesUsing(["wood", "metal", "wood", null]);
    materials.set("wood", new StandardMaterial("wood-1", scene));
    materials.set("metal", new StandardMaterial("metal-1", scene));
    sync.apply(data);
    const names = () => data.actors.map((actor) => sync.meshForActor(actor.id)!.material?.name);
    const unbound = sync.meshForActor("actor-3")!.material;
    expect(names().slice(0, 3)).toEqual(["wood-1", "metal-1", "wood-1"]);

    materials.set("wood", new StandardMaterial("wood-2", scene));
    materials.set("metal", new StandardMaterial("metal-2", scene));
    resolveMaterial.mockClear();
    onAfterApply.mockClear();
    sync.refreshMaterialsCoalesced("wood");

    expect(names().slice(0, 3)).toEqual(["wood-2", "metal-1", "wood-2"]);
    expect(sync.meshForActor("actor-3")!.material).toBe(unbound);
    expect(asked()).toEqual(["wood", "wood"]);
    // Whatever compiled, the host still hears that the scene was refreshed.
    expect(onAfterApply).toHaveBeenCalledTimes(1);
  });

  it("follows an actor whose Material assignment changed, and drops the one it gave up", async () => {
    const { materials, resolveMaterial, asked } = resolver();
    const { sync, scene } = fixture({ resolveMaterial });
    materials.set("wood", new StandardMaterial("wood-1", scene));
    materials.set("metal", new StandardMaterial("metal-1", scene));
    sync.apply(boxesUsing(["wood"]));
    sync.apply(boxesUsing(["metal"]));
    expect(sync.meshForActor("actor-0")!.material?.name).toBe("metal-1");
    materials.set("wood", new StandardMaterial("wood-2", scene));
    materials.set("metal", new StandardMaterial("metal-2", scene));
    resolveMaterial.mockClear();

    sync.refreshMaterialsCoalesced("wood");
    expect(asked()).toEqual([]);
    expect(sync.meshForActor("actor-0")!.material?.name).toBe("metal-1");
    await Promise.resolve();
    sync.refreshMaterialsCoalesced("metal");
    expect(asked()).toEqual(["metal"]);
    expect(sync.meshForActor("actor-0")!.material?.name).toBe("metal-2");
  });

  it("rebinds the actors with a saved instance of the Material that compiled, through the instance's key", async () => {
    const { materials, resolveMaterial } = resolver();
    const releaseMaterialInstance = vi.fn();
    const { sync, scene } = fixture({ resolveMaterial, releaseMaterialInstance });
    materials.set("parent", new StandardMaterial("parent-1", scene));
    materials.set("other", new StandardMaterial("other-1", scene));
    const data = boxesUsing(["parent", "other"]);
    data.actors[0]!.components[0]!.materialInstance = {
      materialGuid: "parent",
      parameters: { Roughness: { kind: "float", value: 0.2 } },
    };
    sync.apply(data);
    await sync.whenEditorModelsReady();
    expect(sync.meshForActor("actor-0")!.material?.name).toBe("parent-1");

    materials.set("parent", new StandardMaterial("parent-2", scene));
    resolveMaterial.mockClear();
    sync.refreshMaterialsCoalesced("parent");

    expect(resolveMaterial).toHaveBeenCalledWith("parent", expect.objectContaining({ instanceKey: expect.any(String) }));
    expect(sync.meshForActor("actor-0")!.material?.name).toBe("parent-2");
    expect(resolveMaterial).not.toHaveBeenCalledWith("other", expect.anything());
    expect(sync.meshForActor("actor-1")!.material?.name).toBe("other-1");
  });

  it("covers every guid published in one turn with the one pass after the first", async () => {
    const { materials, resolveMaterial, asked } = resolver();
    const { sync, scene, onAfterApply } = fixture({ resolveMaterial });
    for (const guid of ["wood", "metal", "glass"]) materials.set(guid, new StandardMaterial(`${guid}-1`, scene));
    const data = boxesUsing(["wood", "metal", "glass", "stone"]);
    sync.apply(data);
    const names = () => data.actors.slice(0, 3).map((actor) => sync.meshForActor(actor.id)!.material?.name);
    for (const guid of ["wood", "metal", "glass"]) materials.set(guid, new StandardMaterial(`${guid}-2`, scene));
    resolveMaterial.mockClear();
    onAfterApply.mockClear();

    sync.refreshMaterialsCoalesced("wood");
    sync.refreshMaterialsCoalesced("metal");
    sync.refreshMaterialsCoalesced("glass");
    expect(names()).toEqual(["wood-2", "metal-1", "glass-1"]);
    expect(onAfterApply).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(names()).toEqual(["wood-2", "metal-2", "glass-2"]);
    expect(onAfterApply).toHaveBeenCalledTimes(2);
    expect(asked()).toEqual(["wood", "metal", "glass"]);
  });

  it("leaves a child actor with its own Material when its parent's Material compiles", () => {
    const { materials, resolveMaterial } = resolver();
    const { sync, scene } = fixture({ resolveMaterial });
    materials.set("parent", new StandardMaterial("parent-1", scene));
    const data = boxesUsing(["parent", null]);
    data.actors[1]!.parentId = "actor-0";
    // The parent is one visual, so binding it assigns its Material to every mesh beneath it, children included.
    // The child, bound after it, takes its own back; rebinding the parent alone would leave the child with the parent's.
    sync.apply(data);
    sync.apply(structuredClone(data));
    const child = sync.meshForActor("actor-1")!;
    const own = child.material;
    expect(sync.meshForActor("actor-0")!.material?.name).toBe("parent-1");
    expect(child.parent).toBe(sync.meshForActor("actor-0"));
    expect(own?.name).not.toBe("parent-1");

    materials.set("parent", new StandardMaterial("parent-2", scene));
    sync.refreshMaterialsCoalesced("parent");

    expect(sync.meshForActor("actor-0")!.material?.name).toBe("parent-2");
    expect(child.material).toBe(own);
  });

  it("applies a publication that arrived during a chunked apply to its users once the apply completes", async () => {
    const realize = async (publishDuringApply: boolean) => {
      const { materials, resolveMaterial, asked } = resolver();
      const { sync, scene } = fixture({ resolveMaterial });
      materials.set("surface", new StandardMaterial("surface-1", scene));
      materials.set("other", new StandardMaterial("other-1", scene));
      const data = boxesUsing(Array.from({ length: 80 }, (_, index) => (index < 40 ? "surface" : "other")));
      let published = false;
      await sync.applyAsync(data, {
        signal: new AbortController().signal,
        ...fine,
        yieldControl: async () => {
          if (!publishDuringApply || published || sync.actorCount() < 2) return;
          published = true;
          materials.set("surface", new StandardMaterial("surface-2", scene));
          sync.refreshMaterialsCoalesced("surface");
        },
      });
      const nameOf = (actor: SerializedActor) => sync.meshForActor(actor.id)!.material?.name;
      return {
        published,
        surface: data.actors.slice(0, 40).map(nameOf),
        other: data.actors.slice(40).map(nameOf),
        otherAsks: asked().filter((guid) => guid === "other").length,
      };
    };
    const quiet = await realize(false);
    const publishing = await realize(true);

    expect(publishing.published).toBe(true);
    expect(publishing.surface.every((name) => name === "surface-2")).toBe(true);
    expect(publishing.other.every((name) => name === "other-1")).toBe(true);
    // The refresh owed to the publication rebound its users and never asked for the other 40 actors again.
    expect(publishing.otherAsks).toBe(quiet.otherAsks);
  });
});

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
      ...fine,
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
      ...fine,
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
      ...fine,
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
        ...fine,
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
      ...fine,
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

  it.each(["before", "after"] as const)("retires a cancelled request %s completion without adopting it over the replacement", async (replace) => {
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
      ...fine,
      yieldControl: async () => {
        if (requests.mock.calls.length) {
          await delayed.ready;
          controller.abort(failure);
        }
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
    // An unowned in-flight generation retires; a completed cached generation can be reused.
    expect(instantiate).toHaveBeenCalledTimes(replace === "before" ? 0 : 1);
    expect(modelLoads.glbContainerLoadCount(scene)).toBe(replace === "before" ? 2 : 1);
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
    // The superseded retarget upload had no remaining owner and was retired.
    expect(modelLoads.glbContainerLoadCount(scene)).toBe(3);
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
      ...fine,
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
      ...fine,
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

describe("adopting a replaced visual that has child actors", () => {
  function box(id: string, parentId: string | null = null, model = false) {
    const component = createMeshComponent(`${id}-mesh`, "box");
    if (model) component.properties.assetGuid = "model";
    return createActor(id, id, { parentId, components: [component] });
  }
  /** A pass over every actor root reads each root's `parent` once; a lookup of the replaced root's children never does. */
  function countParentReads(mesh: Mesh): () => number {
    let owner: object | null = mesh;
    while (owner && !Object.getOwnPropertyDescriptor(owner, "parent")) owner = Object.getPrototypeOf(owner);
    const accessor = Object.getOwnPropertyDescriptor(owner!, "parent")!;
    let reads = 0;
    Object.defineProperty(mesh, "parent", {
      configurable: true,
      get() { reads += 1; return accessor.get!.call(mesh); },
      set(value) { accessor.set!.call(mesh, value); },
    });
    return () => reads;
  }

  it("moves every child actor onto the adopted visual, in the order the actors were created, without visiting unrelated actors", async () => {
    const { sync } = fixture();
    const bystanders = Array.from({ length: 24 }, (_, index) => box(`bystander-${index}`));
    const first = box("first", "parent");
    const second = box("second", "parent");
    const third = box("third", "parent");
    const loner = box("loner", "other");
    const scene = (model: boolean, children: SerializedActor[]): SerializedScene => ({
      ...createDefaultScene(),
      actors: [...bystanders, box("parent", null, model), box("other", null, model), ...children, loner],
    });
    sync.setMeshAssets({ modelBytes: new Map([["model", encodeTriangleGlb()]]) });
    sync.apply(scene(false, [first, second, third]));
    const replaced = sync.meshForActor("parent")!;

    // Replacing the parent detaches its children and attaches them again in this document's order, which is not the order they were created in.
    sync.apply(scene(true, [third, first, second]));
    const reads = bystanders.map((actor) => countParentReads(sync.meshForActor(actor.id)!));
    await sync.whenEditorModelsReady();

    expect(reads.reduce((total, read) => total + read(), 0)).toBe(0);
    const parent = sync.meshForActor("parent")!;
    expect(parent).not.toBe(replaced);
    expect(replaced.isDisposed()).toBe(true);
    expect(parent.getChildren((node) => node.name.startsWith("editorActor:"), true).map((node) => node.name))
      .toEqual(["editorActor:first", "editorActor:second", "editorActor:third"]);
    for (const child of [first, second, third]) {
      expect(sync.meshForActor(child.id)!.isDisposed()).toBe(false);
      expect(sync.meshForActor(child.id)!.parent).toBe(parent);
    }
    expect(sync.meshForActor("loner")!.parent).toBe(sync.meshForActor("other"));
    expect(sync.meshForActor("other")!.parent).toBeNull();
    expect(sync.meshForActor("bystander-0")!.parent).toBeNull();
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
