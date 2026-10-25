import { afterEach, describe, expect, it } from "vitest";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  type SerializedActor,
  type SerializedScene,
} from "@haptic/core";
import { createTestEngine } from "./create-null-engine";
import { EditorSceneSync } from "./editor-scene-sync";

const handles: Array<ReturnType<typeof createTestEngine>> = [];
afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.scene.dispose();
    handle.engine.dispose();
  }
});

function createSync(): EditorSceneSync {
  const handle = createTestEngine();
  handles.push(handle);
  return new EditorSceneSync(handle.scene);
}

const sceneOf = (actors: SerializedActor[]): SerializedScene => ({ ...createDefaultScene(), actors });
const box = (id: string, overrides: Partial<SerializedActor> = {}) =>
  createActor(id, id, { components: [createMeshComponent(`${id}-mesh`, "box")], ...overrides });
const at = (actor: SerializedActor, position: [number, number, number], scale: [number, number, number] = [1, 1, 1]): SerializedActor => ({
  ...actor, transform: { position, rotation: [0, 0, 0, 1], scale },
});

describe("EditorSceneSync.applyPoses", () => {
  it("moves the edited actors and the actors under them exactly as a full apply does", () => {
    // The child is listed before its parent and follows the parent's move.
    const child = at(box("child", { parentId: "parent" }), [1, 0, 0]);
    const parent = at(box("parent"), [0, 0, 0]);
    const other = at(box("other"), [0, 0, 3]);
    const initial = sceneOf([child, parent, other]);
    const edited = sceneOf([child, at(parent, [5, 2, 0], [2, 2, 2]), other]);

    const fast = createSync();
    fast.apply(initial);
    expect(fast.applyPoses(edited)).toBe(true);
    expect(fast.serializedScene()).toBe(edited);

    const full = createSync();
    full.apply(initial);
    full.apply(edited);

    for (const id of ["child", "parent", "other"]) {
      const moved = fast.meshForActor(id)!;
      const reference = full.meshForActor(id)!;
      expect(moved.isWorldMatrixFrozen).toBe(reference.isWorldMatrixFrozen);
      expect(Array.from(moved.getWorldMatrix().m)).toEqual(Array.from(reference.getWorldMatrix().m));
    }
    expect(fast.meshForActor("child")!.getAbsolutePosition().asArray()).toEqual([7, 2, 0]);
  });

  it("leaves an edit whose visual depends on the pose to the full apply", () => {
    const panel = createActor("panel", "Panel", {
      components: [{ id: "p", classId: "2DPanelComponent", properties: { source: "color" } }],
    });
    const initial = sceneOf([panel]);
    const sync = createSync();
    sync.apply(initial);
    // A 2D Panel's nine-slice is built for its actor scale.
    expect(sync.applyPoses(sceneOf([at(panel, [0, 0, 0], [3, 1, 1])]))).toBe(false);
    expect(sync.serializedScene()).toBe(initial);
  });
});
