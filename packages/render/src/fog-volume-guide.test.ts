import { afterEach, describe, expect, it } from "vitest";
import { Ray, Vector3 } from "@babylonjs/core";
import { createActor, createDefaultScene, identitySerializedTransform } from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import { createEditorCamera } from "./editor-camera";
import { EditorSceneSync } from "./editor-scene-sync";
import { applySceneToBabylonScene, editorComponentMeshName } from "./scene-loader";

const handles: ReturnType<typeof createTestEngine>[] = [];
afterEach(() => {
  for (const { scene, engine } of handles.splice(0)) {
    scene.dispose();
    engine.dispose();
  }
});

describe("fog volume editor guides", () => {
  it.each(["box", "sphere"])("picks the %s volume at its authored bounds", (shape) => {
    const handle = createTestEngine();
    handles.push(handle);
    const data = createDefaultScene();
    data.actors = [createActor("fog", "Fog Volume", { components: [{
      id: "volume", classId: "FogVolumeComponent", properties: { shape, size: [4, 6, 8] },
    }] })];
    applySceneToBabylonScene(handle.scene, data);
    const guide = handle.scene.getMeshByName(editorComponentMeshName("fog", "volume"))!;
    const hit = handle.scene.pickWithRay(new Ray(new Vector3(0, 0, -10), Vector3.Forward()), (mesh) => mesh === guide);
    expect(hit?.hit).toBe(true);
    expect(hit?.pickedPoint?.z).toBeCloseTo(-4, 1);
    // Marquee selection excludes zero-visibility origin helpers, so the guide stays eligible.
    expect(guide.visibility).toBe(1);
    expect(guide.getBoundingInfo().boundingBox.maximum.y).toBeCloseTo(3);
    expect(guide.getChildMeshes().some((mesh) => mesh.name.endsWith(":outline"))).toBe(true);
  });

  it("preserves non-rendering parent transforms, updates without rebuilding, and hides or disposes the whole guide", () => {
    const handle = createTestEngine();
    handles.push(handle);
    createEditorCamera(handle.scene, { mode: "3d" });
    const sync = new EditorSceneSync(handle.scene);
    const quarterTurn: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    const data = createDefaultScene();
    data.actors = [createActor("fog", "Fog Volume", {
      transform: { position: [10, 0, 0], rotation: [0, 0, 0, 1], scale: [2, 1, 1] },
      components: [
        { id: "parent", classId: "ActorComponent", properties: {}, transform: { position: [0, 2, 0], rotation: quarterTurn, scale: [2, 3, 4] } },
        { id: "volume", classId: "FogVolumeComponent", parentId: "parent", properties: {}, transform: { position: [1, 0, 0], rotation: quarterTurn, scale: [1, 1, 1] } },
      ],
    })];
    sync.apply(data);
    const guide = handle.scene.getMeshByName(editorComponentMeshName("fog", "volume"))!;
    const point = Vector3.TransformCoordinates(new Vector3(1, 0, 0), guide.computeWorldMatrix(true));
    expect(point.x).toBeCloseTo(4);
    expect(point.y).toBeCloseTo(4);
    expect(point.z).toBeCloseTo(0);
    const next = structuredClone(data);
    next.actors[0]!.components[0]!.transform!.position = [0, 4, 0];
    next.actors[0]!.components[1]!.properties.density = 0.5;
    sync.apply(next);
    expect(handle.scene.getMeshByName(guide.name)).toBe(guide);
    expect(guide.getAbsolutePosition().x).toBeCloseTo(10);
    expect(guide.getAbsolutePosition().y).toBeCloseTo(6);
    const hidden = structuredClone(next);
    hidden.actors[0]!.visible = false;
    sync.apply(hidden);
    expect(guide.isEnabled()).toBe(false);
    expect(guide.getChildMeshes().every((mesh) => !mesh.isEnabled())).toBe(true);
    const detached = structuredClone(next);
    detached.actors[0]!.components[1]!.parentId = null;
    detached.actors[0]!.components[1]!.transform = identitySerializedTransform();
    sync.apply(detached);
    expect(guide.isEnabled()).toBe(true);
    expect(handle.scene.transformNodes.some((node) => node.name.includes(":attachment-"))).toBe(false);
    sync.dispose();
    expect(guide.isDisposed()).toBe(true);
  });
});
