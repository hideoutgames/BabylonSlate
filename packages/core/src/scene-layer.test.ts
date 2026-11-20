import { describe, expect, it } from "vitest";
import {
  createDefaultSceneLayer,
  editorSceneToSceneLayer,
  normalizeSceneLayer,
  normalizeSceneLayerActorDesign,
  normalizeSceneLayerSpawnList,
  parseOverlayPanelProperties,
  parsePostProcessingPanelProperties,
  parseSceneLayerAnchor,
  postProcessingPanelActive,
  sceneLayerActorFrameBounds,
  sceneLayerCanvasToLayer,
  sceneLayerRelativeAnchorWorldPosition,
  sceneLayerViewBounds,
  sceneLayerToEditorScene,
  walkOverlayPointerHits,
} from "./scene-layer";
import { DEFAULT_LAYER_CAMERA_STATE, LAYER_CAMERA_MIN_ZOOM, layerCameraStartState, updateLayerCameraState } from "./layer-camera";
import { createActor, createDefaultSceneSettings, normalizeScene } from "./scene";
import { createDefaultScene } from "./project";

describe("SceneLayer schema", () => {
  it("creates an empty unlit 2D overlay document with 2D gravity", () => {
    const layer = createDefaultSceneLayer();
    expect(layer.name).toBe("Untitled");
    expect(layer.actors).toEqual([]);
    expect(layer.folders).toEqual([]);
    expect(layer.settings.gravity).toEqual(
      createDefaultSceneSettings("2d").gravity,
    );
    expect(layer.settings.fixedTimestepMs).toBe(
      createDefaultSceneSettings("2d").fixedTimestepMs,
    );
    expect(layer.settings.canvas).toEqual({
      sizeMode: "fullscreen", rootAnchor: "center", scaling: "fitToScreen", customSizePx: { width: 400, height: 300 },
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
    // Post-processing is the project's, shared by every layer: a layer document keeps no passes of its own.
    expect(layer.settings).not.toHaveProperty("postProcessStack");
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
    expect(scene.settings.postProcessStack).toEqual([]);
    expect(scene.actors).toHaveLength(1);
    // A neutral mid grey preview background, so a Multiply visual shows what it does in the editor.
    expect(scene.settings.environmentColor).toEqual([0.5, 0.5, 0.5]);
    expect(scene.overlayEditor).toBe(true);
  });

  it("round-trips the canvas and Camera Location through a normalized editor scene", () => {
    const layer = normalizeSceneLayer({
      name: "HUD",
      settings: {
        canvas: { sizeMode: "custom", customSizePx: { width: 640, height: 360 }, rootAnchor: "topLeft", scaling: "truePixelSize" },
        cameraLocation: [6, -1],
      },
    });
    expect(layer.settings.canvas).toEqual({
      sizeMode: "custom", customSizePx: { width: 640, height: 360 }, rootAnchor: "topLeft", scaling: "truePixelSize",
    });
    const scene = normalizeScene(sceneLayerToEditorScene(layer));
    expect(scene.settings.cameraLocation2D).toEqual([6, -1]);
    const restored = editorSceneToSceneLayer({
      ...scene,
      settings: {
        ...scene.settings,
        layerCanvas: { ...scene.settings.layerCanvas!, sizeMode: "desired", scaling: "fitToScreen" },
        cameraLocation2D: [-2, 3],
      },
    });
    expect(restored.settings.canvas).toEqual({
      sizeMode: "desired", customSizePx: { width: 640, height: 360 }, rootAnchor: "topLeft", scaling: "fitToScreen",
    });
    expect(restored.settings.cameraLocation).toEqual([-2, 3]);
    expect(normalizeSceneLayer({}).settings.cameraLocation).toEqual([0, 0]);
    expect(normalizeScene(createDefaultScene()).settings).not.toHaveProperty("layerCanvas");
  });

  it("keeps Tick On Pause off unless set, and round-trips it through the editor scene", () => {
    expect(normalizeSceneLayer({}).settings.tickOnPause).toBe(false);
    expect(normalizeSceneLayer({ settings: { tickOnPause: "yes" } }).settings.tickOnPause).toBe(false);
    const layer = normalizeSceneLayer({ name: "Pause Menu", settings: { tickOnPause: true } });
    expect(layer.settings.tickOnPause).toBe(true);
    const scene = sceneLayerToEditorScene(layer);
    expect(scene.settings.layerTickOnPause).toBe(true);
    expect(editorSceneToSceneLayer(scene).settings.tickOnPause).toBe(true);
    expect(editorSceneToSceneLayer({ ...scene, settings: { ...scene.settings, layerTickOnPause: false } }).settings.tickOnPause).toBe(false);
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
    expect(restored.settings).not.toHaveProperty("postProcessStack");
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
  it("falls back to the center anchor", () => {
    expect(parseSceneLayerAnchor("nope")).toBe("center");
  });

  it("maps authored XY from the canvas's anchor point to the view's, keeping its distance", () => {
    const canvas = { width: 16, height: 9, center: [0, 0] as const };
    const anchored = (view: { width: number; height: number; center: readonly [number, number] }) =>
      sceneLayerRelativeAnchorWorldPosition({ anchor: "bottomLeft", authoredX: -7, authoredY: -4, canvas, view });
    expect(anchored(canvas)).toEqual({ x: -7, y: -4 });
    expect(anchored({ width: 32, height: 18, center: [0, 0] })).toEqual({ x: -15, y: -8.5 });
    // A canvas whose Root is its top left: the view's centre moved with it.
    expect(sceneLayerRelativeAnchorWorldPosition({
      anchor: "topRight", authoredX: 15, authoredY: -1,
      canvas: { width: 16, height: 9, center: [8, -4.5] },
      view: { width: 20, height: 9, center: [10, -4.5] },
    })).toEqual({ x: 19, y: -1 });
  });

  it("widens the layer bounds to the viewport aspect without stretching them", () => {
    expect(sceneLayerViewBounds({ width: 16, height: 9 }, 16 / 9)).toEqual({ width: 16, height: 9 });
    expect(sceneLayerViewBounds({ width: 16, height: 9 }, 32 / 9)).toEqual({ width: 32, height: 9 });
    expect(sceneLayerViewBounds({ width: 16, height: 9 }, 1)).toEqual({ width: 16, height: 16 });
    expect(sceneLayerViewBounds({ width: 16, height: 9 }, Number.NaN)).toEqual({ width: 16, height: 9 });
  });

  it("maps canvas pixels into layer space through the view's centre and the camera's location, zoom and roll", () => {
    expect(sceneLayerCanvasToLayer(0, 0, 1920, 1080, { width: 19.2, height: 10.8, center: [9.6, -5.4] })).toEqual({ x: 0, y: 0 });
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
    expect(updateLayerCameraState(camera, { x: Number.NaN, y: null, rotation: "45", zoom: undefined }))
      .toEqual({ x: 1, y: 2, rotation: 45, zoom: 1.5 });
    expect(updateLayerCameraState(DEFAULT_LAYER_CAMERA_STATE, { zoom: -3 }).zoom).toBe(LAYER_CAMERA_MIN_ZOOM);
  });

  it("starts a Layer Camera on its authored location, unrolled at zoom 1", () => {
    expect(layerCameraStartState([4, -2])).toEqual({ x: 4, y: -2, rotation: 0, zoom: 1 });
    expect(layerCameraStartState([Number.NaN, 3])).toEqual({ x: 0, y: 3, rotation: 0, zoom: 1 });
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

describe("Post Processing Panel properties", () => {
  it.each([
    { label: "nothing authored", value: undefined, expected: { enabled: true, materialGuid: null }, active: false },
    { label: "a Material", value: { materialGuid: " mat-1 " }, expected: { enabled: true, materialGuid: "mat-1" }, active: true },
    { label: "a blank Material", value: { materialGuid: "  " }, expected: { enabled: true, materialGuid: null }, active: false },
    { label: "a non-string Material", value: { materialGuid: 7 }, expected: { enabled: true, materialGuid: null }, active: false },
    { label: "switched off with a Material", value: { enabled: false, materialGuid: "mat-1" }, expected: { enabled: false, materialGuid: "mat-1" }, active: false },
    { label: "a non-boolean Enabled", value: { enabled: 0, materialGuid: "mat-1" }, expected: { enabled: true, materialGuid: "mat-1" }, active: true },
  ])("reads $label", ({ value, expected, active }) => {
    const parsed = parsePostProcessingPanelProperties(value);
    expect(parsed).toEqual(expected);
    expect(postProcessingPanelActive(parsed)).toBe(active);
  });

  it("is kept in a Scene Layer document", () => {
    const actor = { ...createActor("a1", "Panel"), components: [{ id: "p", classId: "2DPostProcessingPanelComponent", properties: { materialGuid: "mat-1" } }] };
    expect(normalizeSceneLayer({ actors: [actor] }).actors[0]!.components.map((component) => component.classId))
      .toEqual(["2DPostProcessingPanelComponent"]);
  });
});

describe("SceneLayerActor Prefab frame", () => {
  const context = { resolution: { width: 1920, height: 1080 }, pixelsPerUnit: 100 };

  it("defaults to a Fullscreen frame of the design resolution centred on the Root", () => {
    const design = normalizeSceneLayerActorDesign(undefined);
    expect(design).toMatchObject({ sizeMode: "fullscreen", rootAnchor: "center" });
    expect(sceneLayerActorFrameBounds(design, context, null)).toEqual({ width: 19.2, height: 10.8, center: [0, 0] });
    expect(sceneLayerActorFrameBounds(design, { resolution: { width: 640, height: 360 }, pixelsPerUnit: 16 }, null))
      .toEqual({ width: 40, height: 22.5, center: [0, 0] });
  });

  it("drops unknown modes, anchors and non-positive sizes", () => {
    expect(normalizeSceneLayerActorDesign({ sizeMode: "stretch", rootAnchor: "middle", customSizePx: { width: 0, height: -2 } }))
      .toEqual(normalizeSceneLayerActorDesign(undefined));
  });

  it("converts a Custom pixel size to layer units around the chosen pivot", () => {
    const design = normalizeSceneLayerActorDesign({ sizeMode: "custom", customSizePx: { width: 400, height: 200 }, rootAnchor: "bottomLeft" });
    expect(sceneLayerActorFrameBounds(design, context, null)).toEqual({ width: 4, height: 2, center: [2, 1] });
    const centred = { ...design, rootAnchor: "center" as const };
    expect(sceneLayerActorFrameBounds(centred, { ...context, pixelsPerUnit: 50 }, null)).toEqual({ width: 8, height: 4, center: [0, 0] });
  });

  it("wraps Desired around the content and has no frame without content", () => {
    const design = normalizeSceneLayerActorDesign({ sizeMode: "desired" });
    expect(sceneLayerActorFrameBounds(design, context, null)).toBeNull();
    expect(sceneLayerActorFrameBounds(design, context, { minX: -1, minY: 2, maxX: 3, maxY: 5 }))
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
