import { describe, expect, it } from "vitest";
import {
  createDefaultSceneLayer,
  editorSceneToSceneLayer,
  normalizeSceneLayer,
  normalizeSceneLayerActorDesign,
  normalizeSceneLayerSpawnList,
  parseOverlayPanelProperties,
  parseSceneLayerAnchor,
  sceneLayerActorFrameBounds,
  sceneLayerCanvasToLayer,
  sceneLayerFrustumSize,
  sceneLayerOrthoBounds,
  sceneLayerRelativeAnchorWorldPosition,
  sceneLayerViewBounds,
  sceneLayerToEditorScene,
  updateSceneLayerCamera,
  walkOverlayPointerHits,
  SCENE_LAYER_CAMERA_MIN_ZOOM,
  SCENE_LAYER_DEFAULT_CAMERA,
} from "./scene-layer";
import { createActor, createDefaultSceneSettings, normalizeScene } from "./scene";
import { createDefaultScene } from "./project";

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

  it("normalizes a partial payload and drops unsupported world-only components", () => {
    const layer = normalizeSceneLayer({
      name: "HUD",
      actors: [
        {
          ...createActor("banner", "Banner", { classId: "SceneLayerActor" }),
          components: [
            { id: "sprite", classId: "SpriteComponent", properties: {} },
            { id: "landscape", classId: "LandscapeComponent", properties: {} },
            { id: "foliage", classId: "FoliageComponent", properties: {} },
            { id: "sky", classId: "SkyboxComponent", properties: {} },
            { id: "cam", classId: "CameraComponent", properties: {} },
            { id: "capture", classId: "RenderTargetCaptureComponent", properties: { renderTargetGuid: "depth" } },
            { id: "arm", classId: "SpringArmComponent", properties: {} },
            { id: "spline", classId: "SplineComponent", properties: {} },
            { id: "light", classId: "LightComponent", properties: {} },
            { id: "area", classId: "AreaRectLightComponent", properties: {} },
            { id: "fog", classId: "FogVolumeComponent", properties: {} },
            { id: "outline", classId: "OutlineComponent", properties: {} },
            { id: "ragdoll", classId: "RagdollComponent", properties: { enabled: true } },
            { id: "landscape", classId: "LandscapeComponent", properties: {} },
            { id: "foliage", classId: "FoliageComponent", properties: {} },
            ...["GlobalWaterVolumeComponent", "WaterOceanComponent", "WaterLakeComponent", "WaterRiverComponent", "WaterPuddleComponent", "WaterBuoyancyComponent"].map((classId) => ({ id: classId, classId, properties: {} })),
            {
              id: "fill",
              classId: "HemisphericFillLightComponent",
              properties: {},
            },
          ],
        },
      ],
      settings: {
        postProcessStack: [{ id: "pass-1", materialGuid: "pp-1" }],
        sceneLayers: [{ assetGuid: "should-ignore" }],
      },
    });
    expect(layer.name).toBe("HUD");
    expect(layer.actors[0]?.classId).toBe("SceneLayerActor");
    expect(layer.actors[0]?.components.map((c) => c.classId)).toEqual([
      "SpriteComponent",
    ]);
    expect(layer.settings.postProcessStack).toEqual([
      { id: "pass-1", materialGuid: "pp-1", enabled: true },
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

  it("projects a SceneLayer into a locked 2D editor scene", () => {
    const layer = normalizeSceneLayer({
      name: "HUD",
      settings: { gravity: [0, -4, 0], postProcessStack: [{ id: "pass", materialGuid: "pp" }] },
      actors: [createActor("a", "A", { classId: "SceneLayerActor" })],
    });
    const scene = sceneLayerToEditorScene(layer);
    expect(scene.viewportMode).toBe("2d");
    expect(scene.settings.physicsWorld).toBe("2d");
    expect(scene.settings.gravity).toEqual([0, -4, 0]);
    expect(scene.settings.postProcessStack).toEqual([
      { id: "pass", materialGuid: "pp", enabled: true },
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

  it("keeps an Outliner anchor pose-free without consuming its layout offsets on save", () => {
    const layer = normalizeSceneLayer({
      name: "HUD",
      settings: { layerBounds: { width: 16, height: 9 } },
      actors: [
        {
          ...createActor("badge", "Badge", {
          classId: "SceneLayerActor",
          components: [
            {
              id: "anchor",
              classId: "2DAnchorComponent",
              properties: { anchor: "topLeft", offsetX: 1, offsetY: -0.5 },
            },
          ],
          }),
          transform: { position: [3, 4, 5], rotation: [0, 0, 1, 0], scale: [2, 3, 4] },
        },
      ],
    });
    expect(layer.actors[0]?.transform).toEqual({
      position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
    });
    expect(layer.actors[0]?.components[0]?.transform).toBeUndefined();
    expect(layer.actors[0]?.components[0]?.properties).toEqual({ anchor: "topLeft", offsetX: 1, offsetY: -0.5 });
    expect(editorSceneToSceneLayer(sceneLayerToEditorScene(layer))).toEqual(layer);
  });

  it("round-trips an editor scene back to a SceneLayer payload", () => {
    const layer = normalizeSceneLayer({
      name: "HUD",
      settings: { gravity: [0, -4, 0], postProcessStack: [{ id: "pass", materialGuid: "pp" }] },
      actors: [createActor("a", "A", { classId: "SceneLayerActor" })],
    });
    const restored = editorSceneToSceneLayer(sceneLayerToEditorScene(layer));
    expect(restored.name).toBe("HUD");
    expect(restored.settings.gravity).toEqual([0, -4, 0]);
    expect(restored.settings.postProcessStack).toEqual([
      { id: "pass", materialGuid: "pp", enabled: true },
    ]);
    expect(restored.actors).toHaveLength(1);
  });

  it("keeps physics off unless the layer enables it, and round-trips Enable Physics through a normalized editor scene", () => {
    expect(normalizeSceneLayer({ name: "HUD" }).settings.physicsEnabled).toBe(false);
    expect(normalizeSceneLayer({ settings: { physicsEnabled: "yes" } }).settings.physicsEnabled).toBe(false);
    const layer = normalizeSceneLayer({ name: "Arena", settings: { physicsEnabled: true } });
    expect(layer.settings.physicsEnabled).toBe(true);
    const editor = normalizeScene(sceneLayerToEditorScene(layer));
    expect(editorSceneToSceneLayer(editor).settings.physicsEnabled).toBe(true);
    expect(editorSceneToSceneLayer({
      ...editor, settings: { ...editor.settings, layerPhysicsEnabled: false },
    }).settings.physicsEnabled).toBe(false);
    expect(normalizeScene(createDefaultScene()).settings).not.toHaveProperty("layerPhysicsEnabled");
  });
});

describe("SceneLayer anchors and hit tests", () => {
  it("sizes the 16x9 frustum and falls back to the center anchor", () => {
    expect(sceneLayerFrustumSize(16 / 9)).toEqual({ width: 16, height: 9 });
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
    ).toEqual({ x: 0, y: -9 });
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
    ).toEqual({ x: 5.333333333333334, y: -4.5 });
  });

  it("widens the layer bounds to the viewport aspect without stretching them", () => {
    expect(sceneLayerViewBounds({ width: 16, height: 9 }, 16 / 9)).toEqual({ width: 16, height: 9 });
    expect(sceneLayerViewBounds({ width: 16, height: 9 }, 32 / 9)).toEqual({ width: 32, height: 9 });
    expect(sceneLayerViewBounds({ width: 16, height: 9 }, 1)).toEqual({ width: 16, height: 16 });
    expect(sceneLayerViewBounds({ width: 16, height: 9 }, Number.NaN)).toEqual({ width: 16, height: 9 });
  });

  it("maps canvas pixels into layer space through the camera's centre, zoom and roll", () => {
    const view = { width: 32, height: 18 };
    expect(sceneLayerCanvasToLayer(0, 0, 1920, 1080, view)).toEqual({ x: -16, y: 9 });
    expect(sceneLayerCanvasToLayer(1920, 1080, 1920, 1080, view)).toEqual({ x: 16, y: -9 });
    const camera = { x: 5, y: -2, rotation: 0, zoom: 2 };
    expect(sceneLayerCanvasToLayer(960, 540, 1920, 1080, view, camera)).toEqual({ x: 5, y: -2 });
    expect(sceneLayerCanvasToLayer(1920, 0, 1920, 1080, view, camera)).toEqual({ x: 13, y: 2.5 });
    // A camera turned 90° counter-clockwise has the canvas's right edge pointing along layer +Y.
    const rolled = sceneLayerCanvasToLayer(1920, 540, 1920, 1080, view, { x: 1, y: 1, rotation: 90, zoom: 1 });
    expect(rolled.x).toBeCloseTo(1);
    expect(rolled.y).toBeCloseTo(17);
  });

  it("keeps the current camera value for non-finite changes and never zooms to 0", () => {
    const camera = { x: 1, y: 2, rotation: 30, zoom: 1.5 };
    expect(updateSceneLayerCamera(camera, { x: Number.NaN, y: null, rotation: "45", zoom: undefined }))
      .toEqual({ x: 1, y: 2, rotation: 45, zoom: 1.5 });
    expect(updateSceneLayerCamera(SCENE_LAYER_DEFAULT_CAMERA, { zoom: -3 }).zoom).toBe(SCENE_LAYER_CAMERA_MIN_ZOOM);
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
  it("keeps margins as 0-1 source fractions", () => {
    expect(parseOverlayPanelProperties({ marginLeft: 0.5 }).marginLeft).toBe(0.5);
    expect(parseOverlayPanelProperties({ marginRight: 10 }).marginRight).toBe(1);
  });
});

describe("SceneLayerActor Prefab frame", () => {
  it("defaults to a Fullscreen frame hanging from the Root at its top right", () => {
    const design = normalizeSceneLayerActorDesign(undefined);
    expect(design).toMatchObject({ sizeMode: "fullscreen", rootAnchor: "topRight" });
    expect(sceneLayerActorFrameBounds(design, 100, null)).toEqual({ width: 32, height: 18, center: [-16, -9] });
  });

  it("drops unknown modes, anchors and non-positive sizes", () => {
    expect(normalizeSceneLayerActorDesign({ sizeMode: "stretch", rootAnchor: "middle", customSizePx: { width: 0, height: -2 } }))
      .toEqual(normalizeSceneLayerActorDesign(undefined));
  });

  it("converts a Custom pixel size to layer units around the chosen pivot", () => {
    const design = normalizeSceneLayerActorDesign({ sizeMode: "custom", customSizePx: { width: 400, height: 200 }, rootAnchor: "bottomLeft" });
    expect(sceneLayerActorFrameBounds(design, 100, null)).toEqual({ width: 4, height: 2, center: [2, 1] });
    const centred = { ...design, rootAnchor: "center" as const };
    expect(sceneLayerActorFrameBounds(centred, 50, null)).toEqual({ width: 8, height: 4, center: [0, 0] });
  });

  it("wraps Desired around the content and has no frame without content", () => {
    const design = normalizeSceneLayerActorDesign({ sizeMode: "desired" });
    expect(sceneLayerActorFrameBounds(design, 100, null)).toBeNull();
    expect(sceneLayerActorFrameBounds(design, 100, { minX: -1, minY: 2, maxX: 3, maxY: 5 }))
      .toEqual({ width: 4, height: 3, center: [1, 3.5] });
  });
});

describe("embedded scripts", () => {
  const script = {
    nodes: [{ id: "begin", type: "flow.event.beginPlay", position: { x: 0, y: 0 }, data: {} }],
    edges: [],
    members: [{ id: "score", kind: "variable" as const, name: "Score", typeId: "int" }],
  };

  it("keeps a Scene's script and drops a malformed one or Actor-only parts", () => {
    expect(normalizeScene({ script: { ...script, components: [{ id: "c" }] } }).script).toEqual(script);
    expect(normalizeScene({ script: { nodes: "x" } })).not.toHaveProperty("script");
    expect(normalizeScene({})).not.toHaveProperty("script");
  });

  it("carries a Scene Layer's script through the editor tab and back", () => {
    const layer = normalizeSceneLayer({ ...createDefaultSceneLayer(), script });
    expect(layer.script).toEqual(script);
    const editor = sceneLayerToEditorScene(layer);
    expect(editor.script).toEqual(script);
    expect(editorSceneToSceneLayer(editor).script).toEqual(script);
    expect(editorSceneToSceneLayer({ ...editor, script: undefined })).not.toHaveProperty("script");
  });
});
