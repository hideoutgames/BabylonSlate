import { NullEngine, StandardMaterial, Vector3 } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createActor, createDefaultScene, parseJoystick2DProperties, walkOverlayPointerHits } from "@babylonslate/core";
import { Joystick2DInput } from "./joystick2d-input";
import { createJoystick2DMesh, joystick2DMesh, refreshJoystick2DMaterials } from "./joystick2d-mesh";
import { SceneLayerCompositor } from "./scene-layer-compositor";
import { applyAssignMesh, createSnapshotSceneBinding, type AssignMeshCommand } from "./snapshot-apply";
import { applySceneToBabylonScene } from "./scene-loader";

describe("SceneLayer joystick", () => {
  const engines: NullEngine[] = [];
  afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

  function setup(properties: Record<string, unknown> = {}) {
    const engine = new NullEngine({ renderWidth: 800, renderHeight: 450, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 4 });
    engines.push(engine);
    const compositor = new SceneLayerCompositor({ engine });
    const layer = compositor.create({ type: "sceneLayerCreate", layerId: "controls", assetGuid: "controls", zOrder: 0, ownerSceneGuid: null, postProcessStack: [] });
    const binding = createSnapshotSceneBinding();
    binding.liveSlots.add(1);
    const command: AssignMeshCommand = {
      type: "assignMesh", slotId: 1, actorGuid: "stick", sceneLayerId: "controls", meshKind: "2djoystick", meshAssetGuid: null, hitTest: "block",
      parts: [{ componentId: "joystick", meshKind: "2djoystick", meshAssetGuid: null, parentId: null,
        position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
        joystick: parseJoystick2DProperties({ radius: 2, joystickRadius: 1, deadZone: 0.2, ...properties }) }],
    };
    applyAssignMesh(layer.scene, binding, command);
    const root = binding.meshes.get(1)!;
    const mesh = root.getChildMeshes().find(child => joystick2DMesh(child))!;
    const visual = joystick2DMesh(mesh)!;
    const axes = new Map<string, number>();
    const input = new Joystick2DInput(id => compositor.layers().find(entry => entry.layerId === id),
      () => ({ width: 800, height: 450 }), (controlId, value) => axes.set(controlId, value));
    const hits = (x = 400, y = 225) => walkOverlayPointerHits(compositor.pickHits(x, y)).targets;
    const value = () => ({ x: axes.get("joystick-x") ?? 0, y: axes.get("joystick-y") ?? 0 });
    return { layer, compositor, binding, command, root, visual, input, hits, value };
  }

  it("routes a picked runtime component into Touch input, clamps travel, and resets only its owning pointer", () => {
    const { input, hits, visual, value } = setup();
    expect(input.down(7, hits(), 400, 225)).toBe(true);
    input.move(7, 402.5, 225); // 0.1 layer units: inside the dead zone.
    expect(value()).toEqual({ x: 0, y: 0 });
    input.move(7, 415, 225); // 0.6 travel -> (0.6 - 0.2) / 0.8 = 0.5.
    expect(value()?.x).toBeCloseTo(0.5);
    expect(visual.thumb.position.x).toBeCloseTo(0.6);
    expect(input.down(8, hits(), 400, 225)).toBe(true);
    input.move(8, 200, 225);
    input.release(8);
    expect(value()?.x).toBeCloseTo(0.5);
    input.move(7, 800, -175);
    const diagonal = value()!;
    expect(diagonal.x).toBeCloseTo(Math.SQRT1_2);
    expect(diagonal.y).toBeCloseTo(Math.SQRT1_2);
    expect(Math.hypot(visual.thumb.position.x, visual.thumb.position.y)).toBeCloseTo(1);
    input.release(7);
    expect(value()).toEqual({ x: 0, y: 0 });
    expect(visual.thumb.position.asArray()).toEqual([0, 0, -0.01]);
  });

  it("uses component-local travel after actor rotation and scale and cancels hidden or retired visuals", () => {
    const { input, hits, root, visual, value } = setup({ deadZone: 0 });
    root.scaling.set(2, 2, 1);
    root.rotation.z = Math.PI / 2;
    input.down(1, hits(), 400, 225);
    input.move(1, 400, 200); // world +Y = local +X after a quarter turn.
    expect(value()?.x).toBeCloseTo(0.5);
    expect(visual.thumb.position.x).toBeCloseTo(0.5);
    root.setEnabled(false);
    input.refresh();
    expect(value()).toEqual({ x: 0, y: 0 });
    root.setEnabled(true);
    input.down(2, hits(), 400, 225);
    input.move(2, 400, 175);
    expect(value()?.x).toBeCloseTo(1);
    root.dispose();
    expect(value()).toEqual({ x: 0, y: 0 });
  });

  it("keeps another held joystick's contribution when one finger releases", () => {
    const { layer, input, hits, value } = setup({ deadZone: 0 });
    const second = createJoystick2DMesh(layer.scene, "second", { radius: 2, joystickRadius: 1, deadZone: 0 });
    second.position.x = 4;
    second.metadata = { ...second.metadata, overlayActorGuid: "second" };
    second.computeWorldMatrix(true);
    expect(input.down(1, hits(), 400, 225)).toBe(true);
    input.move(1, 412.5, 225);
    expect(input.down(2, hits(500, 225), 500, 225)).toBe(true);
    input.move(2, 525, 225);
    expect(value()).toEqual({ x: 1, y: 0 });
    input.release(2);
    expect(value()).toEqual({ x: 0.5, y: 0 });
    input.reset();
    expect(value()).toEqual({ x: 0, y: 0 });
  });

  it("keeps a joystick behind a blocking layer inactive and rejects disabled controls", () => {
    const disabled = setup({ enabled: false });
    expect(disabled.input.down(1, disabled.hits(), 400, 225)).toBe(false);
    const { layer, compositor, input, hits } = setup();
    const other = compositor.create({ type: "sceneLayerCreate", layerId: "menu", assetGuid: "menu", zOrder: 1, ownerSceneGuid: null, postProcessStack: [] });
    const blocker = createJoystick2DMesh(other.scene, "menu-stick");
    blocker.metadata = { ...blocker.metadata, overlayActorGuid: "menu" };
    const blockedHits = hits();
    expect(blockedHits).toHaveLength(1);
    expect(blockedHits[0]?.layerId).toBe("menu");
    expect(input.down(2, blockedHits, 400, 225)).toBe(true);
    expect(layer.scene.meshes.some(mesh => joystick2DMesh(mesh))).toBe(true);
    input.reset();
  });

  it("renders independently assigned materials in the editor and preserves borrowed materials through replacement and disposal", () => {
    const { layer } = setup();
    const background = new StandardMaterial("background", layer.scene);
    const thumb = new StandardMaterial("thumb", layer.scene);
    const materials = new Map([["bg", background], ["thumb", thumb]]);
    const resolveMaterial = (guid: string, options?: { scene?: unknown; unlit?: boolean }) => {
      expect(options).toMatchObject({ scene: layer.scene, unlit: true });
      return materials.get(guid) ?? null;
    };
    const scene = createDefaultScene();
    scene.actors = [createActor("editor-stick", "Stick", { classId: "SceneLayerActor", components: [{ id: "stick", classId: "2DJoystickComponent",
      properties: { backgroundMaterialGuid: "bg", joystickMaterialGuid: "thumb", radius: 2, joystickRadius: 0.5 } }] })];
    applySceneToBabylonScene(layer.scene, scene, { resolveMaterial });
    const mesh = layer.scene.meshes.find(candidate => candidate.name.includes("editor-stick") && joystick2DMesh(candidate))!;
    const visual = joystick2DMesh(mesh)!;
    expect(mesh.material).toBe(background);
    expect(visual.thumb.material).toBe(thumb);
    mesh.computeWorldMatrix(true);
    expect(mesh.getBoundingInfo().boundingBox.extendSize).toEqual(new Vector3(2, 2, 0));
    const replacement = new StandardMaterial("replacement", layer.scene);
    materials.set("thumb", replacement);
    refreshJoystick2DMaterials(visual.mesh, { resolveMaterial });
    expect(visual.thumb.material).toBe(replacement);
    visual.mesh.dispose();
    expect(layer.scene.materials).toEqual(expect.arrayContaining([background, thumb, replacement]));
  });
});
