import { Mesh, MeshBuilder, TransformNode } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createActor, createDefaultScene, identitySerializedTransform } from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import { EditorSceneSync } from "./editor-scene-sync";
import { OverlayLayoutRenderer, overlayClipAllowsPoint } from "./overlay-layout-render";
import { applySceneToBabylonScene, editorComponentMeshName, helperBillboardIconOf } from "./scene-loader";
import { SceneLayerCompositor } from "./scene-layer-compositor";

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); vi.restoreAllMocks(); });

describe("SceneLayer layout rendering", () => {
  it("clips normal and expanded touch picks through imported transform nodes, and clears a removed layout", () => {
    const { engine, scene } = createTestEngine();
    vi.spyOn(engine, "getRenderWidth").mockReturnValue(256);
    vi.spyOn(engine, "getRenderHeight").mockReturnValue(256);
    const compositor = new SceneLayerCompositor({ engine });
    const layer = compositor.create({ type: "sceneLayerCreate", layerId: "hud", assetGuid: "hud", zOrder: 0,
      ownerSceneGuid: null, postProcessStack: [], layerBounds: { width: 2, height: 2 } });
    const renderer = new OverlayLayoutRenderer(id => id === "hud" ? layer.scene : undefined);
    cleanup.push(() => { renderer.dispose(); compositor.dispose(); scene.dispose(); engine.dispose(); });
    const root = new Mesh("actor-1", layer.scene);
    root.isPickable = false;
    const importedTransform = new TransformNode("imported", layer.scene);
    importedTransform.parent = root;
    const button = MeshBuilder.CreatePlane("button", { size: 1.5 }, layer.scene);
    button.parent = importedTransform;
    button.metadata = { overlayActorGuid: "button", overlayHitTest: "block", overlayHasButton: true };
    button.computeWorldMatrix(true);
    const entry = { actorId: "button", slotId: 1, rect: { x: 0, y: 0, width: 2, height: 2 },
      clip: { x: 0, y: 0.5, width: 2, height: 1 }, scrollAncestors: ["scroll"] };
    renderer.apply({ type: "sceneLayerLayout", layerId: "hud", entries: [entry] });
    expect(compositor.pickHits(128, 64).map(hit => hit.actorGuid)).toEqual(["button"]);
    expect(compositor.pickHits(128, 192)).toEqual([]);
    // This misses the physical quad but reaches it through the touch floor.
    const touch = { minTargetPx: 240, canvasCssHeight: 256 };
    expect(compositor.pickHits(240, 64, touch).map(hit => hit.actorGuid)).toEqual(["button"]);
    expect(compositor.pickHits(240, 192, touch)).toEqual([]);
    renderer.apply({ type: "sceneLayerLayout", layerId: "hud", entries: [] });
    expect(compositor.pickHits(128, 192).map(hit => hit.actorGuid)).toEqual(["button"]);
    renderer.apply({ type: "sceneLayerLayout", layerId: "hud", entries: [entry] });
    renderer.remove("hud");
    expect(compositor.pickHits(128, 192).map(hit => hit.actorGuid)).toEqual(["button"]);
  });

  it("installs retained clips on a visual that arrives after the layout command", () => {
    const { engine, scene } = createTestEngine();
    const renderer = new OverlayLayoutRenderer(() => scene);
    cleanup.push(() => { renderer.dispose(); scene.dispose(); engine.dispose(); });
    renderer.apply({ type: "sceneLayerLayout", layerId: "hud", entries: [{ actorId: "text", slotId: 7,
      rect: { x: 0, y: 0, width: 2, height: 2 }, clip: { x: 0, y: 0, width: 1, height: 1 }, scrollAncestors: ["scroll"] }] });
    const root = new Mesh("actor-7", scene);
    const glyph = MeshBuilder.CreatePlane("glyph", {}, scene);
    glyph.parent = root;
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(overlayClipAllowsPoint(glyph, 0, 0)).toBe(true);
    expect(overlayClipAllowsPoint(glyph, 1, 0)).toBe(false);
    renderer.dispose();
    expect(overlayClipAllowsPoint(glyph, 1, 0)).toBe(true);
  });

  it.each(["full", "incremental"] as const)("updates invisible editor box pick bounds and child clips during %s apply", (mode) => {
    const { engine, scene } = createTestEngine();
    const sync = new EditorSceneSync(scene);
    cleanup.push(() => { sync.dispose(); scene.dispose(); engine.dispose(); });
    const document = createDefaultScene("2d");
    const box = { id: "scroll", classId: "2DScrollBoxComponent", properties: { width: 4, height: 4 }, transform: identitySerializedTransform() };
    const child = { id: "content", classId: "2DMaterialComponent", parentId: "scroll", properties: {}, transform: identitySerializedTransform() };
    document.actors = [createActor("panel", "Panel", { components: [box, child] })];
    const apply = () => mode === "full" ? applySceneToBabylonScene(scene, document) : sync.apply(document);
    apply();
    expect(helperBillboardIconOf(document.actors[0]!)).toBeNull();
    const pickBox = scene.getMeshByName(editorComponentMeshName("panel", "scroll"))!;
    expect(pickBox.visibility).toBe(0);
    expect(pickBox.isPickable).toBe(true);
    expect(pickBox.getBoundingInfo().boundingBox.extendSize.x * 2).toBe(4);
    expect(overlayClipAllowsPoint(scene.getMeshByName(editorComponentMeshName("panel", "content"))!, 1.5, 0)).toBe(true);
    box.properties.width = 2;
    apply();
    const resized = scene.getMeshByName(editorComponentMeshName("panel", "scroll"))!;
    expect(resized.visibility).toBe(0);
    expect(resized.getBoundingInfo().boundingBox.extendSize.x * 2).toBe(2);
    expect(overlayClipAllowsPoint(scene.getMeshByName(editorComponentMeshName("panel", "content"))!, 1.5, 0)).toBe(false);
  });
});
