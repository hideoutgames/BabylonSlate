import { describe, expect, it, afterEach } from "vitest";
import { createDefaultScene } from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import {
  applySceneToBabylonScene,
  clearSceneMeshes,
  countSceneMeshes,
} from "./scene-loader";

describe("scene-loader", () => {
  const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
    [];

  afterEach(() => {
    while (handles.length > 0) {
      const handle = handles.pop();
      handle?.scene.dispose();
      handle?.engine.dispose();
    }
  });

  function createHandle() {
    const handle = createTestEngine();
    handles.push(handle);
    return handle;
  }

  it("creates one box mesh from default scene data", () => {
    const { scene } = createHandle();
    applySceneToBabylonScene(scene, createDefaultScene());
    expect(countSceneMeshes(scene)).toBe(1);
    expect(scene.getMeshByName("cube")).not.toBeNull();
  });

  it("replaces meshes when loading a new scene", () => {
    const { scene } = createHandle();
    applySceneToBabylonScene(scene, createDefaultScene());
    applySceneToBabylonScene(scene, {
      name: "Other",
      meshes: [
        { id: "box-a", type: "box", position: [1, 0, 0] },
        { id: "box-b", type: "box", position: [2, 0, 0] },
      ],
    });

    expect(countSceneMeshes(scene)).toBe(2);
    expect(scene.getMeshByName("cube")).toBeNull();
    expect(scene.getMeshByName("box-a")).not.toBeNull();
  });

  it("handles empty mesh list", () => {
    const { scene } = createHandle();
    applySceneToBabylonScene(scene, createDefaultScene());
    applySceneToBabylonScene(scene, { name: "Empty", meshes: [] });
    expect(countSceneMeshes(scene)).toBe(0);
  });

  it("clearSceneMeshes removes all non-root meshes", () => {
    const { scene } = createHandle();
    applySceneToBabylonScene(scene, createDefaultScene());
    clearSceneMeshes(scene);
    expect(countSceneMeshes(scene)).toBe(0);
  });

  it("places each box at its serialized position", () => {
    const { scene } = createHandle();
    applySceneToBabylonScene(scene, {
      name: "Positions",
      meshes: [{ id: "box-a", type: "box", position: [1, 2, 3] }],
    });

    const box = scene.getMeshByName("box-a");
    expect(box).not.toBeNull();
    expect([box!.position.x, box!.position.y, box!.position.z]).toEqual([
      1, 2, 3,
    ]);
  });

  it("ignores mesh definitions of unknown type", () => {
    const { scene } = createHandle();
    applySceneToBabylonScene(scene, {
      name: "Unknown",
      meshes: [
        { id: "box-a", type: "box", position: [0, 0, 0] },
        {
          id: "mystery",
          type: "sphere" as unknown as "box",
          position: [0, 0, 0],
        },
      ],
    });

    expect(countSceneMeshes(scene)).toBe(1);
    expect(scene.getMeshByName("mystery")).toBeNull();
  });

  it("clearSceneMeshes is safe on an already empty scene", () => {
    const { scene } = createHandle();
    clearSceneMeshes(scene);
    expect(countSceneMeshes(scene)).toBe(0);
  });
});
