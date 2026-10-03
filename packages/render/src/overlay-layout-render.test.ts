import { Mesh, MeshBuilder, StandardMaterial, TransformNode } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createActor, createDefaultScene, createMeshComponent, identitySerializedTransform, resolveOverlayLayout } from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import { EditorSceneSync } from "./editor-scene-sync";
import { applyEditorLayoutClips, OverlayLayoutRenderer, overlayClipAllowsPoint } from "./overlay-layout-render";
import { canCacheShadowMaterial } from "./shadow-material-policy";
import { applySceneToBabylonScene, editorComponentMeshName, editorMeshName, helperBillboardIconOf } from "./scene-loader";
import { SceneLayerCompositor } from "./scene-layer-compositor";
import { encodeTriangleGlb } from "./glb-test-fixtures";
import * as modelContainer from "./model-container";

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); vi.restoreAllMocks(); });

describe("SceneLayer layout rendering", () => {
  it.each(["editor", "runtime"] as const)("restores shadow caching when %s clipping is cleared or a mesh leaves its clip", (mode) => {
    const { engine, scene } = createTestEngine();
    const renderer = new OverlayLayoutRenderer(() => scene);
    cleanup.push(() => { renderer.dispose(); scene.dispose(); engine.dispose(); });
    const rootName = mode === "editor" ? "editorActor:panel" : "actor-1";
    const root = MeshBuilder.CreatePlane(rootName, {}, scene);
    const glyph = MeshBuilder.CreatePlane("glyph", {}, scene);
    glyph.parent = root;
    const unclipped = MeshBuilder.CreatePlane(`${rootName}|unclipped`, {}, scene);
    unclipped.parent = root;
    const world = MeshBuilder.CreateBox("world", {}, scene);
    const material = new StandardMaterial("opaque", scene);
    for (const mesh of [root, glyph, unclipped, world]) mesh.material = material;
    const afterDraw = vi.fn();
    glyph.onAfterRenderObservable.add(afterDraw);
    const beforeScene = vi.fn();
    const unrelatedSceneObserver = scene.onBeforeRenderObservable.add(beforeScene);
    const rect = { x: 0, y: 0, width: 2, height: 2 };
    const entries = [
      { actorId: "panel", slotId: 1, rect, clip: rect, scrollAncestors: ["scroll"] },
      { actorId: "panel", componentId: "unclipped", slotId: 1, rect, clip: null, scrollAncestors: [] },
    ];
    const apply = (clipped: boolean) => {
      const current = clipped ? entries : [];
      if (mode === "editor") applyEditorLayoutClips(scene, new Map(current.map((entry, index) => [String(index), entry])));
      else renderer.apply({ type: "sceneLayerLayout", layerId: "hud", entries: current });
    };
    apply(true);
    expect(canCacheShadowMaterial(material, glyph)).toBe(false);
    expect(canCacheShadowMaterial(material, unclipped)).toBe(true);
    expect(canCacheShadowMaterial(material, world)).toBe(true);
    glyph.parent = null;
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(canCacheShadowMaterial(material, glyph)).toBe(true);
    glyph.parent = root;
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(canCacheShadowMaterial(material, glyph)).toBe(false);
    apply(false);
    expect(canCacheShadowMaterial(material, root)).toBe(true);
    expect(canCacheShadowMaterial(material, glyph)).toBe(true);
    glyph.onAfterRenderObservable.notifyObservers(glyph);
    expect(afterDraw).toHaveBeenCalledOnce();
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(beforeScene).toHaveBeenCalled();
    scene.onBeforeRenderObservable.remove(unrelatedSceneObserver);
    apply(true);
    expect(canCacheShadowMaterial(material, glyph)).toBe(false);
    if (mode === "runtime") renderer.remove("hud");
    else apply(false);
    expect(canCacheShadowMaterial(material, glyph)).toBe(true);
  });

  it("preserves layout and clipping when an asynchronous editor model replaces a primitive", async () => {
    const { engine, scene } = createTestEngine();
    const sync = new EditorSceneSync(scene);
    const originalLoad = modelContainer.loadModelContainer;
    let release!: () => void;
    const admission = new Promise<void>(resolve => { release = resolve; });
    let loaded!: () => void;
    const ready = new Promise<void>(resolve => { loaded = resolve; });
    vi.spyOn(modelContainer, "loadModelContainer").mockImplementation(async (...args) => {
      const container = await originalLoad(...args);
      loaded();
      await admission;
      return container;
    });
    cleanup.push(() => { release(); sync.dispose(); scene.dispose(); engine.dispose(); });
    sync.setMeshAssets({ modelBytes: new Map([["model", encodeTriangleGlb()]]) });
    const document = createDefaultScene("2d");
    const component = createMeshComponent("visual", "box");
    const content = createActor("content", "Content", { parentId: "panel", components: [component] });
    content.transform.position = [3, 4, 0];
    document.actors = [createActor("panel", "Panel", { components: [{ id: "scroll", classId: "2DScrollBoxComponent", properties: { width: 4, height: 4 } }] }), content];
    sync.apply(document);
    const previous = sync.meshForActor("content")!;
    const arranged = previous.position.asArray();
    expect(arranged).not.toEqual(content.transform.position);
    expect(overlayClipAllowsPoint(previous, 3, 0)).toBe(false);
    component.properties.assetGuid = "model";
    sync.apply(document);
    await ready;
    expect(sync.meshForActor("content")).toBe(previous);
    release();
    await sync.whenEditorModelsReady();
    const adopted = sync.meshForActor("content")!;
    expect(adopted).not.toBe(previous);
    expect(previous.isDisposed()).toBe(true);
    expect(adopted.position.asArray()).toEqual(arranged);
    expect(overlayClipAllowsPoint(adopted, 0, 0)).toBe(true);
    expect(overlayClipAllowsPoint(adopted, 3, 0)).toBe(false);
    expect(sync.serializedScene()!.actors[1]!.transform.position).toEqual([3, 4, 0]);
  });

  it("routes scroll to the deepest available viewport within its inherited clip", () => {
    const renderer = new OverlayLayoutRenderer(() => undefined);
    cleanup.push(() => renderer.dispose());
    const rect = { x: 0, y: 0, width: 4, height: 4 };
    const scroll = { x: 0, y: 0, maxX: 0, maxY: 10, axis: "vertical" as const, viewport: rect, scaleX: 1, scaleY: 1 };
    const outer = { actorId: "outer", slotId: 1, rect, clip: null, scrollAncestors: [], scroll };
    const inner = { actorId: "inner", slotId: 2, rect, clip: { ...rect, width: 2 }, scrollAncestors: ["outer"], scroll, interactive: true };
    renderer.apply({ type: "sceneLayerLayout", layerId: "hud", entries: [outer, inner] });
    expect(renderer.scrollAt("hud", 0, 0)?.actorId).toBe("inner");
    expect(renderer.scrollAt("hud", 1.5, 0)?.actorId).toBe("outer");
    renderer.apply({ type: "sceneLayerLayout", layerId: "hud", entries: [outer, { ...inner, interactive: false }] });
    expect(renderer.scrollAt("hud", 0, 0)?.actorId).toBe("outer");
  });

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

  it("preserves cached transforms on unchanged frames and reapplies layout to replacement visuals", () => {
    const { engine, scene } = createTestEngine();
    const renderer = new OverlayLayoutRenderer(() => scene);
    cleanup.push(() => { renderer.dispose(); scene.dispose(); engine.dispose(); });
    const mesh = new Mesh("actor-7|text", scene);
    const transform = identitySerializedTransform();
    transform.position = [2, 3, 0];
    const command = { type: "sceneLayerLayout" as const, layerId: "hud", entries: [{ actorId: "text", componentId: "text", slotId: 7,
      rect: { x: 2, y: 3, width: 2, height: 2 }, clip: { x: 2, y: 3, width: 1, height: 1 }, scrollAncestors: [], transform }] };
    renderer.apply(command);
    mesh.freezeWorldMatrix();
    const lookup = vi.spyOn(scene, "getMeshByName");
    for (let i = 0; i < 3; i += 1) scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(mesh.isWorldMatrixFrozen).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
    renderer.apply(command);
    expect(mesh.isWorldMatrixFrozen).toBe(true);

    mesh.dispose();
    const replacement = new Mesh("actor-7|text", scene);
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(replacement.position.asArray()).toEqual([2, 3, 0]);
    expect(overlayClipAllowsPoint(replacement, 2, 3)).toBe(true);
    expect(overlayClipAllowsPoint(replacement, 0, 0)).toBe(false);
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

  it.each(["full", "incremental"] as const)("matches arranged bounds through Anchor carriers and transformed boxes during %s apply", (mode) => {
    const { engine, scene } = createTestEngine();
    const sync = new EditorSceneSync(scene);
    cleanup.push(() => { sync.dispose(); scene.dispose(); engine.dispose(); });
    const document = createDefaultScene("2d");
    const box = { id: "column", classId: "2DVerticalBoxComponent", properties: { width: 4, height: 4 }, transform: identitySerializedTransform() };
    box.transform.position = [1, -1, 0];
    box.transform.scale = [2, 1, 1];
    const parent = createActor("panel", "Panel", { components: [box] });
    parent.transform.position = [5, 3, 0];
    parent.transform.scale = [2, 2, 1];
    parent.transform.rotation = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    const anchor = createActor("anchor", "Anchor", { parentId: "panel", components: [{ id: "pin", classId: "2DAnchorComponent", properties: {} }] });
    const nested = createActor("nested", "Nested Anchor", { parentId: "anchor", components: [{ id: "pin", classId: "2DAnchorComponent", properties: {} }] });
    const content = createActor("content", "Content", { parentId: "nested", components: [{ id: "visual", classId: "2DMaterialComponent", properties: {} }] });
    document.actors = [parent, anchor, nested, content];
    const authored = structuredClone(document.actors);
    const apply = () => mode === "full" ? applySceneToBabylonScene(scene, document) : sync.apply(document);
    const expectPosition = (expectedY: number) => {
      const mesh = scene.getMeshByName(editorMeshName("content"))!;
      expect(mesh.parent).toBe(scene.getMeshByName(editorMeshName("panel")));
      mesh.computeWorldMatrix(true);
      const position = mesh.getAbsolutePosition();
      expect(position.x).toBeCloseTo(4);
      expect(position.y).toBeCloseTo(expectedY);
      const rect = resolveOverlayLayout(document.actors).entries.get("content/visual")!.rect;
      expect(rect.x).toBeCloseTo(position.x);
      expect(rect.y).toBeCloseTo(position.y);
      expect(rect.width).toBeCloseTo(2);
      expect(rect.height).toBeCloseTo(4);
      expect(scene.getMeshByName(editorMeshName("anchor"))).toBeNull();
      expect(scene.getMeshByName(editorMeshName("nested"))).toBeNull();
    };
    apply();
    expectPosition(-1);
    expect(document.actors).toEqual(authored);
    box.transform.position[0] = 2;
    apply();
    expectPosition(1);
    expect(content.parentId).toBe("nested");
    expect(content.transform.position).toEqual([0, 0, 0]);
  });
});
