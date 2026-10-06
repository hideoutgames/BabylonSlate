import { NullEngine, RawTexture, StandardMaterial } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createActor, createDefaultScene, parseUIControl2DProperties, walkOverlayPointerHits } from "@babylonslate/core";
import { UIControls2DInput, type SceneLayerControlEvent } from "./ui-controls2d-input";
import { createUIControl2DMesh, refreshUIControl2DMaterials, uiControl2DMesh } from "./ui-controls2d-mesh";
import { SceneLayerCompositor } from "./scene-layer-compositor";
import { applyAssignMesh, applyUIControl2DCommand, createSnapshotSceneBinding, type AssignMeshCommand } from "./snapshot-apply";
import { applySceneToBabylonScene } from "./scene-loader";
import type { TextureResources } from "./resource-cache";

describe("SceneLayer controls", () => {
  const engines: NullEngine[] = [];
  afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

  function setup(classId = "2DSliderComponent", properties: Record<string, unknown> = {}) {
    const engine = new NullEngine({ renderWidth: 800, renderHeight: 450, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 4 });
    engines.push(engine);
    const compositor = new SceneLayerCompositor({ engine });
    const layer = compositor.create({ type: "sceneLayerCreate", layerId: "controls", assetGuid: "controls", zOrder: 0, ownerSceneGuid: null, postProcessStack: [] });
    const binding = createSnapshotSceneBinding();
    binding.liveSlots.add(1);
    const command: AssignMeshCommand = {
      type: "assignMesh", slotId: 1, actorGuid: "control-actor", sceneLayerId: "controls", meshKind: "2dcontrol", meshAssetGuid: null, hitTest: "block",
      parts: [{ componentId: "control", meshKind: "2dcontrol", meshAssetGuid: null, parentId: null,
        position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
        uiControl: { classId, properties: parseUIControl2DProperties(classId, { width: 4, height: 1, min: 0, max: 10, step: 1, ...properties }) } }],
    };
    applyAssignMesh(layer.scene, binding, command);
    const root = binding.meshes.get(1)!;
    const visual = uiControl2DMesh(root.getChildMeshes().find(child => uiControl2DMesh(child))!)!;
    const events: SceneLayerControlEvent[] = [];
    const input = new UIControls2DInput(() => compositor.layers(), () => ({ width: 800, height: 450 }), event => events.push(event));
    const hits = (x = 400, y = 225) => walkOverlayPointerHits(compositor.pickHits(x, y)).targets;
    const key = (key: string, shiftKey = false) => input.keyDown({ key, shiftKey, preventDefault() {}, stopPropagation() {} });
    return { layer, compositor, binding, command, root, visual, input, hits, events, key };
  }

  it("picks the component, snaps drag values through transformed local coordinates and commits once", () => {
    const { root, visual, input, hits, events } = setup();
    root.scaling.set(2, 2, 1); root.rotation.z = Math.PI / 2;
    expect(input.down(1, hits(), 400, 225)).toBe(true);
    input.move(1, 400, 175); // world +2 Y -> local +1 X; 75% rounds to 8.
    expect(visual.properties.value).toBe(8);
    expect(visual.surfaces.find(part => part.role === "thumb")!.mesh.position.x).toBeCloseTo(1.2);
    input.move(1, 400, -500);
    input.release(1);
    expect(events.filter(event => event.action === "commit")).toEqual([
      { layerId: "controls", actorGuid: "control-actor", componentId: "control", action: "commit", value: 10 },
    ]);
  });

  it("retains capture across runtime state updates, rejects second-finger stealing and cancels hidden controls", () => {
    const { binding, visual, root, input, hits, events } = setup();
    input.down(1, hits(), 400, 225);
    applyUIControl2DCommand(binding, { type: "setUIControl2D", slotId: 1, componentId: "control",
      uiControl: { classId: "2DSliderComponent", properties: { ...visual.properties, max: 20, value: 8 } } });
    expect(input.down(2, hits(), 400, 225)).toBe(true);
    input.move(2, 800, 225); input.release(2);
    expect(visual.properties.value).toBe(8);
    input.move(1, 425, 225);
    expect(visual.properties.value).toBe(15);
    root.setEnabled(false); input.refresh();
    expect(input.owns(1)).toBe(false);
    expect(events.some(event => event.action === "commit")).toBe(false);
  });

  it("keeps range thumbs ordered and lets keyboard adjustments target the upper thumb with Shift", () => {
    const { input, visual, hits, key } = setup("2DRangeSliderComponent", { lowerValue: 2, upperValue: 7 });
    input.down(1, hits(375, 225), 375, 225);
    input.move(1, 600, 225); input.release(1);
    expect([visual.properties.lowerValue, visual.properties.upperValue]).toEqual([7, 7]);
    key("ArrowRight", true);
    expect([visual.properties.lowerValue, visual.properties.upperValue]).toEqual([7, 8]);
  });

  it.each([
    { value: 0, start: 350, move: 425, expected: [0, 8] },
    { value: 10, start: 450, move: 375, expected: [3, 10] },
    { value: 5, start: 400, move: 375, expected: [3, 5] },
  ])("expands coincident range handles at $value in the first drag direction", ({ value, start, move, expected }) => {
    const { input, visual, hits } = setup("2DRangeSliderComponent", { lowerValue: value, upperValue: value });
    input.down(1, hits(), start, 225);
    expect([visual.properties.lowerValue, visual.properties.upperValue]).toEqual([value, value]);
    input.move(1, move, 225); input.release(1);
    expect([visual.properties.lowerValue, visual.properties.upperValue]).toEqual(expected);
  });

  it("withholds keyboard edits while Tab awaits an authoritative eligible focus target", () => {
    const { compositor, visual } = setup("2DSliderComponent", { value: 3 });
    const requests: boolean[] = [];
    const changes: SceneLayerControlEvent[] = [];
    const input = new UIControls2DInput(() => compositor.layers(), () => ({ width: 800, height: 450 }), event => changes.push(event), undefined, reverse => requests.push(reverse));
    const key = (key: string, shiftKey = false) => input.keyDown({ key, shiftKey, preventDefault() {}, stopPropagation() {} });
    input.syncFocus(visual.mesh, true);
    expect(key("Tab", true)).toBe(true);
    expect(requests).toEqual([true]);
    expect(key("ArrowRight")).toBe(false);
    expect(visual.properties.value).toBe(3);
    expect(changes).toEqual([]);
    input.syncFocus(visual.mesh, true);
    key("ArrowRight");
    expect(visual.properties.value).toBe(4);
  });

  it.each(["2DCheckboxComponent", "2DToggleComponent", "2DRadioButtonComponent"])("changes %s once without a second activation request", classId => {
    const { input, visual, hits, events, key } = setup(classId);
    input.down(1, hits(), 400, 225); input.release(1);
    expect(visual.properties.checked).toBe(true);
    expect(events.filter(event => event.action === "change")).toHaveLength(1);
    expect(events.some(event => event.action === "activate")).toBe(false);
    key(" ");
    expect(visual.properties.checked).toBe(classId === "2DRadioButtonComponent");
  });

  it("opens native dropdown rows, picks their component and selects the clicked option", () => {
    const { input, visual, hits, events } = setup("2DDropdownComponent", { options: ["First", "Second", "Third"] });
    input.down(1, hits(), 400, 225); input.release(1);
    expect(visual.expanded).toBe(true);
    const optionHits = hits(400, 275); // second row, two layer units below the root.
    expect(optionHits[0]).toMatchObject({ componentId: "control", controlMeshName: visual.mesh.name });
    input.down(2, optionHits, 400, 275); input.release(2);
    expect(visual.properties.selectedIndex).toBe(1);
    expect(visual.expanded).toBe(false);
    expect(events.filter(event => event.action === "change").at(-1)?.value).toBe(1);
  });

  it("does not optimistically edit read-only sliders or interact with disabled controls and progress meters", () => {
    const readonly = setup("2DSliderComponent", { readOnly: true, value: 3 });
    readonly.input.down(1, readonly.hits(), 400, 225); readonly.input.move(1, 800, 225); readonly.input.release(1);
    expect(readonly.visual.properties.value).toBe(3);
    expect(readonly.events.some(event => event.action === "change")).toBe(false);
    for (const { input, hits } of [setup("2DCheckboxComponent", { enabled: false }), setup("2DProgressBarComponent")]) {
      expect(input.down(1, hits(), 400, 225)).toBe(false);
    }
  });

  it("accepts graph focus without echoing navigation and edits numeric values through keyboard and spinner buttons", () => {
    const { visual, input, key, events, hits } = setup("2DNumericInputComponent", { value: 3 });
    input.syncFocus(visual.mesh, true);
    expect(visual.focused).toBe(true);
    expect(events).toEqual([]);
    key("ArrowUp");
    expect(visual.properties.value).toBe(4);
    input.down(1, hits(440, 220), 440, 220); input.release(1);
    expect(visual.properties.value).toBe(5);
    input.syncFocus(visual.mesh, false);
    expect(key("ArrowUp")).toBe(false);
    expect(events.some(event => event.action === "focus" || event.action === "blur")).toBe(false);
  });

  it("renders controls in the editor, refreshes borrowed per-part materials, and releases texture leases on disposal", () => {
    const { layer } = setup();
    const material = new StandardMaterial("authored", layer.scene);
    const nextMaterial = new StandardMaterial("reloaded", layer.scene);
    let selected = material;
    const resolveMaterial = () => selected;
    const scene = createDefaultScene();
    scene.actors = [createActor("editor-control", "Slider", { classId: "SceneLayerActor", components: [{ id: "slider", classId: "2DSliderComponent",
      properties: { thumbMaterialGuid: "material", width: 6, height: 1 } }] })];
    applySceneToBabylonScene(layer.scene, scene, { resolveMaterial });
    const mesh = layer.scene.meshes.find(candidate => candidate.name.includes("editor-control") && uiControl2DMesh(candidate))!;
    const visual = uiControl2DMesh(mesh)!;
    expect(visual.surfaces.find(part => part.role === "thumb")?.mesh.material).toBe(material);
    selected = nextMaterial; refreshUIControl2DMaterials(visual.mesh, { resolveMaterial });
    expect(visual.surfaces.find(part => part.role === "thumb")?.mesh.material).toBe(nextMaterial);
    visual.mesh.dispose();
    expect(layer.scene.materials).toEqual(expect.arrayContaining([material, nextMaterial]));

    const texture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, layer.scene);
    const release = vi.fn();
    const acquireTexture = vi.fn(() => ({ resource: texture, release }));
    const assets = { textureBytes: new Map([["texture", new Uint8Array([1])]]), resourceCache: { acquireTexture } as unknown as TextureResources, resolveMaterial };
    const textured = createUIControl2DMesh(layer.scene, "textured", { classId: "2DSliderComponent", properties: { trackTextureGuid: "texture", thumbTextureGuid: "texture", thumbMaterialGuid: "material" } }, assets);
    expect(acquireTexture).toHaveBeenCalledTimes(1); // The material suppresses its thumb texture.
    expect(uiControl2DMesh(textured)?.surfaces.find(part => part.role === "thumb")?.mesh.material).toBe(nextMaterial);
    textured.dispose();
    expect(release).toHaveBeenCalledTimes(1);
    expect(layer.scene.materials).toContain(nextMaterial);
  });
});
