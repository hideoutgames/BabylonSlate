import { describe, expect, it } from "vitest";
import { LinesMesh, Vector3, VertexBuffer } from "@babylonjs/core";
import { createActor, createDefaultScene } from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import { EditorSceneSync } from "./editor-scene-sync";
import { editorComponentMeshName } from "./scene-loader";
import { splineMeshBody } from "./spline-mesh";

describe("Spline editor visual", () => {
  it("renders a pickable component-local curve and rebuilds edited points while retaining hierarchy", () => {
    const { engine, scene } = createTestEngine();
    const sync = new EditorSceneSync(scene);
    try {
      const actor = createActor("a", "Path", {
        transform: { position: [10, 2, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        components: [{ id: "path", classId: "SplineComponent", properties: { points: [[0, 0, 0], [0, 3, 6]], curvature: 0 }, transform: { position: [1, 4, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }],
      });
      const document = { ...createDefaultScene(), actors: [actor] };
      sync.apply(document);
      const mesh = scene.getMeshByName(editorComponentMeshName("a", "path"))!;
      expect(mesh).toBeInstanceOf(LinesMesh);
      expect(mesh.isPickable).toBe(true);
      expect(mesh.parent).toBe(sync.meshForActor("a"));
      expect(Vector3.TransformCoordinates(new Vector3(0, 3, 6), mesh.computeWorldMatrix(true)).asArray()).toEqual([11, 9, 6]);
      expect(scene.meshes.some((entry) => entry.name.includes("billboard"))).toBe(false);
      actor.components[0]!.properties = { points: [[0, 0, 0], [2, 5, 8]], curvature: 0 };
      sync.apply(document);
      const updated = scene.getMeshByName(editorComponentMeshName("a", "path"))!;
      expect(mesh.isDisposed()).toBe(true);
      expect(Array.from(updated.getVerticesData(VertexBuffer.PositionKind)!)).toEqual([0, 0, 0, 2, 5, 8]);
      expect(splineMeshBody(updated as LinesMesh)?.points[1]).toEqual([2, 5, 8]);
      expect(updated.parent).toBe(sync.meshForActor("a"));
      sync.apply({ ...document, actors: [] });
      expect(updated.isDisposed()).toBe(true);
    } finally { sync.dispose(); scene.dispose(); engine.dispose(); }
  });
});
