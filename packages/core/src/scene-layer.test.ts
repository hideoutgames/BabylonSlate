import { describe, expect, it } from "vitest";
import {
  createDefaultSceneLayer,
  editorSceneToSceneLayer,
  normalizeSceneLayer,
  normalizeSceneLayerSpawnList,
  parseSceneLayerAnchor,
  sceneLayerAnchorWorldPosition,
  sceneLayerFrustumSize,
  sceneLayerToEditorScene,
  walkOverlayPointerHits,
  SCENE_LAYER_DENIED_COMPONENT_CLASS_IDS,
  SCENE_LAYER_HIT_TESTS,
  SCENE_LAYER_SCHEMA_VERSION,
} from "./scene-layer";
import { createActor, createDefaultSceneSettings } from "./scene";

describe("SceneLayer schema", () => {
  it("creates an empty unlit 2D overlay document with 2D gravity and no post-process", () => {
    const layer = createDefaultSceneLayer();
    expect(layer.name).toBe("Untitled");
    expect(layer.actors).toEqual([]);
    expect(layer.folders).toEqual([]);
    expect(layer.settings.postProcessStack).toEqual([]);
    expect(layer.settings.gravity).toEqual(
      createDefaultSceneSettings("2d").gravity,
    );
    expect(layer.settings.fixedTimestepMs).toBe(
      createDefaultSceneSettings("2d").fixedTimestepMs,
    );
  });

  it("stamps schema version 1 for new SceneLayer assets", () => {
    expect(SCENE_LAYER_SCHEMA_VERSION).toBe(1);
  });

  it("normalizes a partial payload and drops Skybox, Camera, and Light components", () => {
    const layer = normalizeSceneLayer({
      name: "HUD",
      actors: [
        {
          ...createActor("banner", "Banner", { classId: "SceneLayerActor" }),
          components: [
            { id: "sprite", classId: "SpriteComponent", properties: {} },
            { id: "sky", classId: "SkyboxComponent", properties: {} },
            { id: "cam", classId: "CameraComponent", properties: {} },
            { id: "light", classId: "LightComponent", properties: {} },
          ],
        },
      ],
      settings: {
        postProcessStack: [{ materialGuid: "pp-1" }],
        sceneLayers: [{ assetGuid: "should-ignore" }],
      },
    });
    expect(layer.name).toBe("HUD");
    expect(layer.actors[0]?.classId).toBe("SceneLayerActor");
    expect(layer.actors[0]?.components.map((c) => c.classId)).toEqual([
      "SpriteComponent",
    ]);
    expect(layer.settings.postProcessStack).toEqual([
      { materialGuid: "pp-1", enabled: true },
    ]);
    expect(SCENE_LAYER_DENIED_COMPONENT_CLASS_IDS).toEqual([
      "SkyboxComponent",
      "CameraComponent",
      "LightComponent",
    ]);
  });

  it("normalizes a world-scene spawn list by guid, integer z-order, and enabled", () => {
    expect(normalizeSceneLayerSpawnList(undefined)).toEqual([]);
    expect(
      normalizeSceneLayerSpawnList([
        { assetGuid: "layer-a", zOrder: 2.9, enabled: false },
        { zOrder: 1 },
        { assetGuid: "layer-b" },
        null,
      ]),
    ).toEqual([
      { assetGuid: "layer-a", zOrder: 2, enabled: false },
      { assetGuid: "layer-b", zOrder: 0, enabled: true },
    ]);
  });

  it("exposes HitTest enum values for overlay visuals", () => {
    expect(SCENE_LAYER_HIT_TESTS).toEqual(["ignore", "block", "passThrough"]);
  });

  it("projects a SceneLayer into a locked 2D editor scene", () => {
    const layer = normalizeSceneLayer({
      name: "HUD",
      settings: { gravity: [0, -4, 0], postProcessStack: [{ materialGuid: "pp" }] },
      actors: [createActor("a", "A", { classId: "SceneLayerActor" })],
    });
    const scene = sceneLayerToEditorScene(layer);
    expect(scene.viewportMode).toBe("2d");
    expect(scene.settings.physicsWorld).toBe("2d");
    expect(scene.settings.gravity).toEqual([0, -4, 0]);
    expect(scene.settings.postProcessStack).toEqual([
      { materialGuid: "pp", enabled: true },
    ]);
    expect(scene.actors).toHaveLength(1);
  });

  it("round-trips an editor scene back to a SceneLayer payload", () => {
    const layer = normalizeSceneLayer({
      name: "HUD",
      settings: { gravity: [0, -4, 0], postProcessStack: [{ materialGuid: "pp" }] },
      actors: [createActor("a", "A", { classId: "SceneLayerActor" })],
    });
    const restored = editorSceneToSceneLayer(sceneLayerToEditorScene(layer));
    expect(restored.name).toBe("HUD");
    expect(restored.settings.gravity).toEqual([0, -4, 0]);
    expect(restored.settings.postProcessStack).toEqual([
      { materialGuid: "pp", enabled: true },
    ]);
    expect(restored.actors).toHaveLength(1);
  });
});

describe("SceneLayer anchors and hit tests", () => {
  it("places 16x9 overlay anchors at screen-space origins with XY offsets", () => {
    const frustum = sceneLayerFrustumSize(16 / 9);
    expect(frustum).toEqual({ width: 16, height: 9 });
    expect(
      sceneLayerAnchorWorldPosition("topLeft", 0, 0, frustum.width, frustum.height),
    ).toEqual({ x: -8, y: 4.5 });
    expect(
      sceneLayerAnchorWorldPosition("center", 1, -2, frustum.width, frustum.height),
    ).toEqual({ x: 1, y: -2 });
    expect(
      sceneLayerAnchorWorldPosition(
        "bottomRight",
        0.5,
        0.25,
        frustum.width,
        frustum.height,
      ),
    ).toEqual({ x: 8.5, y: -4.25 });
    expect(parseSceneLayerAnchor("nope")).toBe("center");
  });

  it("walks overlay hits high-to-low, skipping Ignore and stopping on Block", () => {
    expect(
      walkOverlayPointerHits([
        { layerId: "hi", actorGuid: "a", hitTest: "ignore" },
        { layerId: "mid", actorGuid: "b", hitTest: "passThrough" },
        { layerId: "lo", actorGuid: "c", hitTest: "block" },
        { layerId: "worldish", actorGuid: "d", hitTest: "block" },
      ]),
    ).toEqual({
      targets: [
        { layerId: "mid", actorGuid: "b", hitTest: "passThrough" },
        { layerId: "lo", actorGuid: "c", hitTest: "block" },
      ],
      blocked: true,
    });
    expect(
      walkOverlayPointerHits([
        { layerId: "hi", actorGuid: "a", hitTest: "ignore" },
        { layerId: "mid", actorGuid: "b", hitTest: "passThrough" },
      ]),
    ).toEqual({
      targets: [{ layerId: "mid", actorGuid: "b", hitTest: "passThrough" }],
      blocked: false,
    });
  });
});
