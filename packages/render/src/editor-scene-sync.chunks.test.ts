import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  type SerializedScene,
} from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import { EditorSceneSync } from "./editor-scene-sync";
import { createEditorCamera } from "./editor-camera";
import { encodeTriangleGlb } from "./model-mesh";
import { visualMeshes } from "./visual-meshes";

const handles: ReturnType<typeof createTestEngine>[] = [];
afterEach(() => {
  for (const { scene, engine } of handles.splice(0)) {
    scene.dispose();
    engine.dispose();
  }
});
function fixture() {
  const handle = createTestEngine();
  handles.push(handle);
  createEditorCamera(handle.scene, { mode: "3d" });
  const onAfterApply = vi.fn();
  return {
    ...handle,
    onAfterApply,
    sync: new EditorSceneSync(handle.scene, undefined, { onAfterApply }),
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
    const next = document(1);
    sync.apply(next);
    resume();
    await rejected;
    expect(sync.serializedScene()).toBe(next);
    expect(sync.actorCount()).toBe(1);
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
        visualMeshes(root).some((mesh) => mesh.getTotalVertices() > 0),
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
