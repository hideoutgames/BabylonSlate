import { afterEach, describe, expect, it } from "vitest";
import {
  createActor,
  createDefaultScene,
  type SerializedScene,
} from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import { EditorDebugOverlay } from "./editor-debug-overlay";

function sceneWith(
  actors: SerializedScene["actors"],
): SerializedScene {
  return { ...createDefaultScene(), actors };
}

describe("EditorDebugOverlay", () => {
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

  it("creates frustum lines and a 1Hz preview RTT when a camera actor is selected", () => {
    const { scene } = createHandle();
    let now = 0;
    const overlay = new EditorDebugOverlay(scene, { now: () => now });
    const sceneData = sceneWith([
      createActor("cam", "Camera", {
        components: [
          {
            id: "camera",
            classId: "CameraComponent",
            properties: { fieldOfView: 60, orthographicSize: 5 },
          },
        ],
      }),
    ]);
    overlay.sync({ sceneData, selectedActorIds: ["cam"] });
    expect(overlay.frustumMesh).not.toBeNull();
    expect(overlay.previewTexture).not.toBeNull();
    expect(overlay.previewRenderCount).toBe(1);

    now = 500;
    overlay.tick();
    expect(overlay.previewRenderCount).toBe(1);

    now = 1000;
    overlay.tick();
    expect(overlay.previewRenderCount).toBe(2);

    overlay.sync({ sceneData, selectedActorIds: [] });
    expect(overlay.frustumMesh).toBeNull();
    expect(overlay.previewTexture).toBeNull();
    overlay.dispose();
  });

  it("builds dashed influence lines for a selected point light and disposes on deselect", () => {
    const { scene } = createHandle();
    const overlay = new EditorDebugOverlay(scene);
    const sceneData = sceneWith([
      createActor("lamp", "Lamp", {
        components: [
          {
            id: "light",
            classId: "LightComponent",
            properties: { lightKind: "point", range: 8, intensity: 1 },
          },
        ],
      }),
    ]);
    overlay.sync({ sceneData, selectedActorIds: ["lamp"] });
    expect(overlay.lightDebugMesh).not.toBeNull();
    expect(overlay.lightDebugKind).toBe("point");
    overlay.sync({ sceneData, selectedActorIds: [] });
    expect(overlay.lightDebugMesh).toBeNull();
    overlay.dispose();
  });

  it("builds a dashed cone for a selected spot light and an arrow for directional", () => {
    const { scene } = createHandle();
    const overlay = new EditorDebugOverlay(scene);
    const spotScene = sceneWith([
      createActor("spot", "Spot", {
        components: [
          {
            id: "light",
            classId: "LightComponent",
            properties: { lightKind: "spot", range: 10, outerAngle: 45 },
          },
        ],
      }),
    ]);
    overlay.sync({ sceneData: spotScene, selectedActorIds: ["spot"] });
    expect(overlay.lightDebugKind).toBe("spot");

    const dirScene = sceneWith([
      createActor("sun", "Sun", {
        components: [
          {
            id: "light",
            classId: "LightComponent",
            properties: { lightKind: "directional" },
          },
        ],
      }),
    ]);
    overlay.sync({ sceneData: dirScene, selectedActorIds: ["sun"] });
    expect(overlay.lightDebugKind).toBe("directional");
    overlay.dispose();
  });

  it("uses a selected CameraComponent on the prefab root", () => {
    const { scene } = createHandle();
    const overlay = new EditorDebugOverlay(scene);
    const sceneData = sceneWith([
      createActor("prefab-root", "Prefab", {
        components: [
          {
            id: "camera",
            classId: "CameraComponent",
            properties: { fieldOfView: 50 },
          },
        ],
      }),
    ]);
    overlay.sync({
      sceneData,
      selectedActorIds: ["prefab-root"],
      selectedComponentIds: ["camera"],
    });
    expect(overlay.frustumMesh).not.toBeNull();
    expect(overlay.previewTexture).not.toBeNull();
    overlay.dispose();
  });
});
