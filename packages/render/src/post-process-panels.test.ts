import { Camera } from "@babylonjs/core/Cameras/camera";
import type { TargetCamera } from "@babylonjs/core/Cameras/targetCamera";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { FrameGraphObjectList } from "@babylonjs/core/FrameGraph/frameGraphObjectList";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import type { SceneLayerPostProcessPanelPayload } from "@haptic/bridge";
import type { MaterialParameterValue, ScenePostProcessEntry } from "@haptic/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  POST_PROCESS_PANEL_CONTENT_MASK,
  POST_PROCESS_PANEL_HIDDEN_MASK,
  ScenePostProcessPanels,
} from "./post-process-panels";
import { drawSceneAuxiliaryViews } from "./scene-auxiliary-views";

const DEFAULT_MASK = 0x0fffffff;
const engines: NullEngine[] = [];
afterEach(() => { while (engines.length) engines.pop()!.dispose(); });

type ViewLog = { slotId: number; camera: TargetCamera; objects: FrameGraphObjectList; stack: ScenePostProcessEntry[]; parameters: Array<[string, MaterialParameterValue]> };

/**
 * A 200 × 100 layer output whose orthographic camera frames x -10..10 and y -5..5 (10 pixels a unit), with actor roots
 * by slot and views that record what they are asked to draw.
 */
function layer() {
  const engine = new NullEngine({ renderWidth: 200, renderHeight: 100, textureSize: 256, deterministicLockstep: false, lockstepMaxSteps: 1 });
  engines.push(engine);
  const scene = new Scene(engine);
  const camera = new UniversalCamera("layerCamera", new Vector3(0, 0, -10), scene);
  camera.setTarget(Vector3.Zero());
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.orthoLeft = -10; camera.orthoRight = 10; camera.orthoBottom = -5; camera.orthoTop = 5;
  scene.activeCamera = camera;
  const roots = new Map<number, AbstractMesh>();
  const views: ViewLog[] = [];
  const draws: number[] = [];
  let drawsSucceed = true;
  const panels = new ScenePostProcessPanels(scene, {
    slotRoot: (slotId) => roots.get(slotId),
    createView: (viewCamera, objects, stack) => {
      const slotId = Number(viewCamera.name.split(":")[1]);
      const log: ViewLog = { slotId, camera: viewCamera, objects, stack, parameters: [] };
      views.push(log);
      return {
        render: () => { draws.push(slotId); return drawsSucceed; },
        setParameter: (name, value) => { log.parameters.push([name, value]); },
        retire: () => Promise.resolve(),
      };
    },
  });
  /** An actor root with a unit quad visual under it. */
  const actor = (slotId: number, position: [number, number], scale: [number, number], parent?: AbstractMesh) => {
    const root = new Mesh(`actor-${slotId}`, scene);
    root.position.set(position[0], position[1], 0);
    root.scaling.set(scale[0], scale[1], 1);
    if (parent) root.parent = parent;
    const visual = MeshBuilder.CreatePlane(`actor-${slotId}-visual`, { size: 1 }, scene);
    visual.parent = root;
    roots.set(slotId, root);
    return { root, visual };
  };
  const frame = (enabled = true) => {
    panels.beforeRender(camera, 200, 100, enabled);
    drawSceneAuxiliaryViews(scene);
  };
  return { engine, scene, camera, panels, actor, views, draws, frame, failDraws: () => { drawsSucceed = false; } };
}

function panel(slotId: number, contentSlotIds: number[], parentSlotId: number | null = null, parameters: Record<string, MaterialParameterValue> = {}): SceneLayerPostProcessPanelPayload {
  return { slotId, componentId: `panel-${slotId}`, materialGuid: "blur", parameters, contentSlotIds, parentSlotId };
}

describe("ScenePostProcessPanels", () => {
  it("builds nothing while the layer has no panel or post-processing is off", () => {
    const { scene, panels, actor, views, frame } = layer();
    const { visual } = actor(1, [1, 0.5], [4, 2]);
    const before = { cameras: scene.cameras.length, meshes: scene.meshes.length, textures: scene.textures.length };
    frame();
    panels.set([panel(1, [1])]);
    frame(false);
    expect(views).toEqual([]);
    expect({ cameras: scene.cameras.length, meshes: scene.meshes.length, textures: scene.textures.length }).toEqual(before);
    expect(visual.layerMask).toBe(DEFAULT_MASK);
  });

  it("draws a panel's content into one target the size of its on-screen rectangle, through the layer camera's view", () => {
    const { camera, panels, actor, views, draws, frame } = layer();
    const { root, visual } = actor(1, [1, 0.5], [4, 2]);
    const child = actor(2, [1, 0.5], [1, 1]);
    const outside = actor(3, [-6, 0], [1, 1]);
    panels.set([panel(1, [1, 2])]);
    frame();
    // Corners x -1..3 and y -0.5..1.5: pixels 90..130 and 45..65.
    expect(panels.views()).toEqual([{ slotId: 1, width: 40, height: 20, presented: true, rect: { x: 90, y: 45, width: 40, height: 20 } }]);
    expect(views).toHaveLength(1);
    const view = views[0]!;
    expect(view.stack).toEqual([{ id: "panel", materialGuid: "blur", enabled: true, parameters: {} }]);
    expect(view.camera.outputRenderTarget?.getSize()).toEqual({ width: 40, height: 20 });
    expect([view.camera.orthoLeft, view.camera.orthoRight, view.camera.orthoBottom, view.camera.orthoTop].map((v) => Number(v!.toFixed(6))))
      .toEqual([-1, 3, -0.5, 1.5]);
    expect(view.camera.getViewMatrix(true).asArray()).toEqual(camera.getViewMatrix(true).asArray());
    // Until its first drawn frame the content still draws in the layer.
    expect(draws).toEqual([1]);
    expect(visual.layerMask).toBe(DEFAULT_MASK);
    frame();
    expect(new Set(view.objects.meshes)).toEqual(new Set([root, visual, child.root, child.visual]));
    expect([root, visual, child.root, child.visual].map((mesh) => mesh.layerMask)).toEqual(Array(4).fill(POST_PROCESS_PANEL_CONTENT_MASK));
    expect(outside.visual.layerMask).toBe(DEFAULT_MASK);
    // The result covers the same pixels at the panel's depth.
    const quad = view.camera.getScene().meshes.find((mesh) => mesh.name === "postProcessPanelResult:1")!;
    expect(quad.isEnabled()).toBe(true);
    expect([quad.position.x, quad.position.y, quad.scaling.x, quad.scaling.y].map((v) => Number(v.toFixed(6)))).toEqual([1, 0.5, 4, 2]);
    expect(quad.isPickable).toBe(false);
  });

  it("clamps a partly off-screen panel's target and clips content of a panel wholly off screen", () => {
    const { panels, actor, views, frame } = layer();
    const { root, visual } = actor(1, [9, 0], [4, 2]);
    panels.set([panel(1, [1])]);
    frame();
    // x 7..11 clamps to 7..10: pixels 170..200.
    expect(panels.views().map((view) => [view.width, view.height])).toEqual([[30, 20]]);
    root.position.x = 30;
    frame();
    expect(views).toHaveLength(1);
    expect(panels.views()[0]!.rect).toBeNull();
    expect(visual.layerMask).toBe(POST_PROCESS_PANEL_HIDDEN_MASK);
    root.position.x = 0;
    frame();
    // Back on screen at another size: a new target of that size.
    expect(views).toHaveLength(2);
    expect(panels.views().map((view) => [view.width, view.height])).toEqual([[40, 20]]);
  });

  it("draws nested panels inner first and puts the inner result in the outer panel's content", () => {
    const { panels, actor, views, draws, frame } = layer();
    const outer = actor(1, [0, 0], [8, 6]);
    const inner = actor(2, [1, 1], [2, 2]);
    panels.set([panel(2, [2], 1), panel(1, [1], null)]);
    frame();
    frame();
    expect(draws.slice(0, 2)).toEqual([2, 1]);
    const outerView = views.find((view) => view.slotId === 1)!;
    const innerView = views.find((view) => view.slotId === 2)!;
    const innerQuad = inner.root.getScene().meshes.find((mesh) => mesh.name === "postProcessPanelResult:2")!;
    expect(outerView.objects.meshes).toContain(innerQuad);
    expect(outerView.objects.meshes).not.toContain(inner.visual);
    expect(innerView.objects.meshes).toContain(inner.visual);
    expect(innerQuad.layerMask).toBe(POST_PROCESS_PANEL_CONTENT_MASK);
    expect(outer.visual.layerMask).toBe(POST_PROCESS_PANEL_CONTENT_MASK);
  });

  it("keeps a panel whose view cannot draw a plain container", () => {
    const { panels, actor, frame, failDraws } = layer();
    const { visual } = actor(1, [0, 0], [4, 2]);
    failDraws();
    panels.set([panel(1, [1])]);
    frame();
    frame();
    expect(visual.layerMask).toBe(DEFAULT_MASK);
    expect(visual.getScene().meshes.find((mesh) => mesh.name === "postProcessPanelResult:1")?.isEnabled()).toBe(false);
  });

  it("hands live parameter writes to its pass and starts a rebuilt pass from them", () => {
    const { panels, actor, views, frame } = layer();
    const { root } = actor(1, [0, 0], [4, 2]);
    panels.set([panel(1, [1], null, { Strength: { kind: "float", value: 1 } })]);
    frame();
    expect(views[0]!.stack[0]!.parameters).toEqual({ Strength: { kind: "float", value: 1 } });
    expect(panels.setParameter(1, "panel-1", "blur", "Strength", { kind: "float", value: 3 })).toBe(true);
    expect(views[0]!.parameters).toEqual([["Strength", { kind: "float", value: 3 }]]);
    expect(panels.setParameter(1, "panel-1", "other-material", "Strength", { kind: "float", value: 5 })).toBe(false);
    expect(panels.setParameter(1, "other-component", "blur", "Strength", { kind: "float", value: 5 })).toBe(false);
    root.scaling.x = 6;
    frame();
    expect(views).toHaveLength(2);
    expect(views[1]!.stack[0]!.parameters).toEqual({ Strength: { kind: "float", value: 3 } });
  });

  it("gives every mask back and builds nothing more once its panels are gone", () => {
    const { scene, panels, actor, frame } = layer();
    const { visual } = actor(1, [0, 0], [4, 2]);
    panels.set([panel(1, [1])]);
    frame();
    frame();
    expect(visual.layerMask).toBe(POST_PROCESS_PANEL_CONTENT_MASK);
    panels.set([]);
    frame();
    expect(visual.layerMask).toBe(DEFAULT_MASK);
    expect(scene.meshes.some((mesh) => mesh.name.startsWith("postProcessPanelResult"))).toBe(false);
    expect(panels.active).toBe(false);
  });

  it("hits a panel's content only inside the panel's rectangle", () => {
    const { panels, actor, frame } = layer();
    const { visual } = actor(1, [0, 0], [4, 2]);
    panels.set([panel(1, [1])]);
    frame();
    frame();
    // Pixels 80..120 across, 40..60 up (40..60 from the top too).
    expect(panels.allowsPick(visual, 100, 50, 100)).toBe(true);
    expect(panels.allowsPick(visual, 70, 50, 100)).toBe(false);
    expect(panels.allowsPick(visual, 100, 30, 100)).toBe(false);
  });
});
