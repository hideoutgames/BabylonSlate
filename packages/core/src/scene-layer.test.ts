import { describe, expect, it } from "vitest";
import {
  createDefaultSceneLayer,
  editorSceneToSceneLayer,
  normalizeSceneLayer,
  normalizeSceneLayerSpawnList,
  parseOverlayPanelProperties,
  parseSceneLayerAnchor,
  sceneLayerAnchorWorldPosition,
  sceneLayerFrustumSize,
  sceneLayerOrthoBounds,
  sceneLayerRelativeAnchorWorldPosition,
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
    expect(layer.settings.layerBounds).toEqual({ width: 32, height: 18 });
  });

  it("resolves Play HUD ortho from layerBounds and defaults to 32x18", () => {
    expect(sceneLayerOrthoBounds()).toEqual({ width: 32, height: 18 });
    expect(sceneLayerOrthoBounds({ width: 20, height: 10 })).toEqual({
      width: 20,
      height: 10,
    });
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
            {
              id: "fill",
              classId: "HemisphericFillLightComponent",
              properties: {},
            },
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
      "HemisphericFillLightComponent",
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
    expect(scene.settings.cameraBounds2D).toEqual({ width: 32, height: 18 });
    expect(scene.settings.environmentColor).toEqual([0, 0, 0]);
    expect(scene.overlayEditor).toBe(true);
  });

  it("round-trips layer bounds through the editor scene as the orange camera frame", () => {
    const layer = normalizeSceneLayer({
      name: "HUD",
      settings: { layerBounds: { width: 20, height: 10 } },
    });
    expect(layer.settings.layerBounds).toEqual({ width: 20, height: 10 });
    const scene = sceneLayerToEditorScene(layer);
    expect(scene.settings.cameraBounds2D).toEqual({ width: 20, height: 10 });
    const restored = editorSceneToSceneLayer({
      ...scene,
      settings: {
        ...scene.settings,
        cameraBounds2D: { width: 24, height: 12 },
      },
    });
    expect(restored.settings.layerBounds).toEqual({ width: 24, height: 12 });
  });

  it("bakes identity-transform 2DAnchor offsets into authored XY so 16x9 layout does not jump", () => {
    const layer = normalizeSceneLayer({
      name: "HUD",
      settings: { layerBounds: { width: 16, height: 9 } },
      actors: [
        createActor("badge", "Badge", {
          classId: "SceneLayerActor",
          components: [
            {
              id: "anchor",
              classId: "2DAnchorComponent",
              properties: { anchor: "topLeft", offsetX: 1, offsetY: -0.5 },
            },
          ],
        }),
      ],
    });
    expect(layer.actors[0]?.transform.position[0]).toBe(-7);
    expect(layer.actors[0]?.transform.position[1]).toBe(4);
    expect(layer.actors[0]?.components[0]?.properties.offsetX).toBe(0);
    expect(layer.actors[0]?.components[0]?.properties.offsetY).toBe(0);
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

  it("maps authored XY relative to the orange layer bounds onto the Play frustum", () => {
    expect(
      sceneLayerRelativeAnchorWorldPosition({
        anchor: "bottomLeft",
        authoredX: 8,
        authoredY: -4.5,
        layerWidth: 16,
        layerHeight: 9,
        frustumWidth: 16,
        frustumHeight: 9,
      }),
    ).toEqual({ x: 8, y: -4.5 });
    expect(
      sceneLayerRelativeAnchorWorldPosition({
        anchor: "bottomLeft",
        authoredX: 8,
        authoredY: -4.5,
        layerWidth: 16,
        layerHeight: 9,
        frustumWidth: 32,
        frustumHeight: 18,
      }),
    ).toEqual({ x: 16, y: -9 });
    expect(
      sceneLayerRelativeAnchorWorldPosition({
        anchor: "bottomLeft",
        authoredX: 8,
        authoredY: -4.5,
        layerWidth: 16,
        layerHeight: 9,
        frustumWidth: 21.333333333333332,
        frustumHeight: 9,
      }),
    ).toEqual({ x: 10.666666666666666, y: -4.5 });
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

describe("2DPanel properties", () => {
  it("defaults to a texture source with zero 9-slice margins", () => {
    expect(parseOverlayPanelProperties({})).toEqual({
      source: "texture",
      textureGuid: null,
      materialGuid: null,
      marginLeft: 0,
      marginRight: 0,
      marginTop: 0,
      marginBottom: 0,
      hitTest: "ignore",
    });
  });

  it("keeps 0-1 margins as fractions and values above 1 as legacy pixels", () => {
    expect(parseOverlayPanelProperties({ marginLeft: 0.5 }).marginLeft).toBe(0.5);
    expect(parseOverlayPanelProperties({ marginRight: 10 }).marginRight).toBe(10);
  });
});
