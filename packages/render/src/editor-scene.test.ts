import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Mesh, StandardMaterial, Vector3 } from "@babylonjs/core";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  type SerializedScene,
} from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import {
  createEditorCamera,
  MAX_CAMERA_RADIUS,
  TWO_D_ALPHA,
  TWO_D_BETA,
} from "./editor-camera";
import { EditorSceneSync } from "./editor-scene-sync";
import {
  createEditorGrid,
  gridCoverageWorld,
  snapGridOrigin,
} from "./editor-grid";
import {
  createGizmoHost,
  gizmoAxisEnabledFlags,
  GIZMO_AXIS_COLORS,
  GIZMO_UNIFORM_COLOR,
  DEFAULT_GIZMO_HANDLE_SCALE,
  GIZMO_COLLIDER_SCALE,
  GIZMO_END_CAP_SCALE,
} from "./gizmo-host";
import { SelectionOutline } from "./selection-outline";
import { RenderScheduler } from "./render-scheduler";
import { editorMeshName } from "./scene-loader";

const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
  [];

function createHandle() {
  const handle = createTestEngine();
  handles.push(handle);
  return handle;
}

function sceneWith(actors: SerializedScene["actors"]): SerializedScene {
  return { ...createDefaultScene(), actors };
}

afterEach(() => {
  while (handles.length > 0) {
    const handle = handles.pop();
    handle?.scene.dispose();
    handle?.engine.dispose();
  }
});

describe("editor camera controller", () => {
  it("starts in perspective and switches to an orthographic 2D camera", () => {
    const { scene } = createHandle();
    const controller = createEditorCamera(scene, { mode: "3d" });
    expect(controller.camera.mode).toBe(0);

    controller.setMode("2d");
    expect(controller.mode).toBe("2d");
    expect(controller.camera.mode).toBe(1);
    expect(controller.camera.alpha).toBeCloseTo(TWO_D_ALPHA);
    expect(controller.camera.beta).toBeCloseTo(TWO_D_BETA);
  });

  it("places the 2D camera at negative Z looking toward +Z", () => {
    const { scene } = createHandle();
    const controller = createEditorCamera(scene, { mode: "2d" });
    // The arc camera derives its position from alpha/beta/radius when the view
    // matrix is next built.
    controller.camera.getViewMatrix();
    const position = controller.camera.position;
    expect(position.z).toBeLessThan(0);
    expect(Math.abs(position.x)).toBeLessThan(0.001);
    expect(Math.abs(position.y)).toBeLessThan(0.001);
    expect(scene.useRightHandedSystem).toBe(false);
  });

  it("refuses to orbit in 2D but still pans and zooms", () => {
    const { scene } = createHandle();
    const controller = createEditorCamera(scene, { mode: "2d" });
    const alpha = controller.camera.alpha;

    controller.orbit(1, 1);
    expect(controller.camera.alpha).toBeCloseTo(alpha);

    const before = controller.orthoHalfHeight();
    controller.zoom(2);
    expect(controller.orthoHalfHeight()).toBeCloseTo(before / 2);

    controller.pan(1, 0);
    expect(controller.camera.target.x).not.toBe(0);
  });

  it("looks in place in 3D without moving the camera position", () => {
    const { scene } = createHandle();
    const controller = createEditorCamera(scene, { mode: "3d" });
    controller.camera.getViewMatrix();
    const positionBefore = controller.camera.position.clone();
    const alphaBefore = controller.camera.alpha;

    controller.look(0.3, 0.1);
    controller.camera.getViewMatrix();

    expect(controller.camera.alpha).not.toBeCloseTo(alphaBefore, 5);
    expect(controller.camera.position.x).toBeCloseTo(positionBefore.x, 5);
    expect(controller.camera.position.y).toBeCloseTo(positionBefore.y, 5);
    expect(controller.camera.position.z).toBeCloseTo(positionBefore.z, 5);
  });

  it("refuses to look in 2D", () => {
    const { scene } = createHandle();
    const controller = createEditorCamera(scene, { mode: "2d" });
    controller.look(1, 1);
    expect(controller.camera.alpha).toBeCloseTo(TWO_D_ALPHA);
    expect(controller.camera.beta).toBeCloseTo(TWO_D_BETA);
  });

  it("flies forward along the look direction in 3D", () => {
    const { scene } = createHandle();
    const controller = createEditorCamera(scene, { mode: "3d" });
    controller.camera.getViewMatrix();
    const positionBefore = controller.camera.position.clone();
    const forward = controller.camera.getDirection(Vector3.Forward()).normalize();

    controller.fly(2, 0);
    controller.camera.getViewMatrix();

    const moved = controller.camera.position.subtract(positionBefore);
    expect(moved.length()).toBeCloseTo(2, 4);
    expect(moved.normalize().dot(forward)).toBeCloseTo(1, 4);
  });

  it("flies as XY pan in 2D", () => {
    const { scene } = createHandle();
    const controller = createEditorCamera(scene, { mode: "2d" });
    const targetBefore = controller.camera.target.clone();

    controller.fly(3, 2);

    expect(controller.camera.target.x).toBeCloseTo(targetBefore.x + 2, 5);
    expect(controller.camera.target.y).toBeCloseTo(targetBefore.y + 3, 5);
  });

  it("keeps orthographic bounds aspect correct", () => {
    const { scene } = createHandle();
    const controller = createEditorCamera(scene, {
      mode: "2d",
      orthoHalfHeight: 5,
    });
    controller.updateOrthoBounds(2);
    expect(controller.camera.orthoTop).toBe(5);
    expect(controller.camera.orthoRight).toBe(10);
    expect(controller.camera.orthoLeft).toBe(-10);
  });

  it("clamps perspective zoom to the radius limits", () => {
    const { scene } = createHandle();
    const controller = createEditorCamera(scene, { mode: "3d" });
    controller.zoom(0.0001);
    expect(controller.camera.radius).toBeLessThanOrEqual(MAX_CAMERA_RADIUS);
  });

  it("invalidates the scheduler when the camera moves", () => {
    const { scene } = createHandle();
    const scheduler = new RenderScheduler();
    const invalidate = vi.spyOn(scheduler, "invalidate");
    const controller = createEditorCamera(scene, { scheduler });
    invalidate.mockClear();

    controller.orbit(0.1, 0);
    controller.pan(1, 1);
    controller.frame(new Vector3(1, 2, 3), 4);

    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(invalidate).toHaveBeenCalledWith("camera");
  });

  it("restores 3D orbit, radius, and target after a 2D detour", () => {
    const { scene } = createHandle();
    const controller = createEditorCamera(scene, { mode: "3d" });
    controller.look(0.4, 0.2);
    controller.zoom(2);
    controller.frame(new Vector3(3, 4, 5));
    const alpha = controller.camera.alpha;
    const beta = controller.camera.beta;
    const radius = controller.camera.radius;
    const target = controller.camera.target.clone();

    controller.setMode("2d");
    controller.frame(new Vector3(-8, 2, 0));
    controller.setMode("3d");

    expect(controller.camera.alpha).toBeCloseTo(alpha, 5);
    expect(controller.camera.beta).toBeCloseTo(beta, 5);
    expect(controller.camera.radius).toBeCloseTo(radius, 5);
    expect(controller.camera.target.x).toBeCloseTo(target.x, 5);
    expect(controller.camera.target.y).toBeCloseTo(target.y, 5);
    expect(controller.camera.target.z).toBeCloseTo(target.z, 5);
  });

  it("restores 2D pan and ortho zoom after a 3D detour", () => {
    const { scene } = createHandle();
    const controller = createEditorCamera(scene, { mode: "2d" });
    controller.frame(new Vector3(6, -3, 0));
    controller.zoom(2);
    const target = controller.camera.target.clone();
    const halfHeight = controller.orthoHalfHeight();

    controller.setMode("3d");
    controller.frame(new Vector3(1, 1, 1), 12);
    controller.setMode("2d");

    expect(controller.camera.target.x).toBeCloseTo(target.x, 5);
    expect(controller.camera.target.y).toBeCloseTo(target.y, 5);
    expect(controller.orthoHalfHeight()).toBeCloseTo(halfHeight, 5);
  });

  it("keeps 3D and 2D targets independent after both modes have been visited", () => {
    const { scene } = createHandle();
    const controller = createEditorCamera(scene, { mode: "3d" });
    controller.frame(new Vector3(5, 6, 7), 10);

    controller.setMode("2d");
    controller.frame(new Vector3(-3, 4, 0));

    controller.setMode("3d");
    expect(controller.camera.target.x).toBeCloseTo(5, 5);
    expect(controller.camera.target.y).toBeCloseTo(6, 5);
    expect(controller.camera.target.z).toBeCloseTo(7, 5);

    controller.setMode("2d");
    expect(controller.camera.target.x).toBeCloseTo(-3, 5);
    expect(controller.camera.target.y).toBeCloseTo(4, 5);
  });

  it("pins look to the 2D convention on the first switch from 3D", () => {
    const { scene } = createHandle();
    const controller = createEditorCamera(scene, { mode: "3d" });
    controller.look(0.5, 0.2);

    controller.setMode("2d");

    expect(controller.camera.alpha).toBeCloseTo(TWO_D_ALPHA);
    expect(controller.camera.beta).toBeCloseTo(TWO_D_BETA);
  });

  it("restores pixel-perfect zoom when returning to 2D", () => {
    const { scene } = createHandle();
    const controller = createEditorCamera(scene, { mode: "2d" });
    controller.setCanvasHeight(600);
    controller.setPixelPerfect({ pixelsPerUnit: 100, integerZoomSteps: true });
    controller.zoom(2);
    expect(controller.pixelZoom()).toBe(2);

    controller.setMode("3d");
    controller.setMode("2d");

    expect(controller.pixelZoom()).toBe(2);
    expect(controller.orthoHalfHeight()).toBe(1.5);
  });

  it("exports 3D live pose and stored 2D pose for a remounted controller", () => {
    const { scene } = createHandle();
    const controller = createEditorCamera(scene, { mode: "3d" });
    controller.look(0.4, 0.2);
    controller.zoom(2);
    controller.frame(new Vector3(3, 4, 5));
    const alpha = controller.camera.alpha;
    const beta = controller.camera.beta;
    const radius = controller.camera.radius;
    const target3d = controller.camera.target.clone();

    controller.setMode("2d");
    controller.frame(new Vector3(-8, 2, 0));
    controller.zoom(2);
    const target2d = controller.camera.target.clone();
    const halfHeight = controller.orthoHalfHeight();

    controller.setMode("3d");
    const exported = controller.exportSessionState();

    const remounted = createEditorCamera(scene, { mode: "3d" });
    remounted.importSessionState(exported);

    expect(remounted.camera.alpha).toBeCloseTo(alpha, 5);
    expect(remounted.camera.beta).toBeCloseTo(beta, 5);
    expect(remounted.camera.radius).toBeCloseTo(radius, 5);
    expect(remounted.camera.target.x).toBeCloseTo(target3d.x, 5);
    expect(remounted.camera.target.y).toBeCloseTo(target3d.y, 5);
    expect(remounted.camera.target.z).toBeCloseTo(target3d.z, 5);

    remounted.setMode("2d");
    expect(remounted.camera.target.x).toBeCloseTo(target2d.x, 5);
    expect(remounted.camera.target.y).toBeCloseTo(target2d.y, 5);
    expect(remounted.orthoHalfHeight()).toBeCloseTo(halfHeight, 5);
  });

  it("exports 2D live pose and stored 3D pose for a remounted controller", () => {
    const { scene } = createHandle();
    const controller = createEditorCamera(scene, { mode: "2d" });
    controller.frame(new Vector3(6, -3, 0));
    controller.zoom(2);
    const target2d = controller.camera.target.clone();
    const halfHeight = controller.orthoHalfHeight();

    controller.setMode("3d");
    controller.look(0.3, 0.1);
    controller.frame(new Vector3(1, 1, 1), 12);
    const alpha = controller.camera.alpha;
    const beta = controller.camera.beta;
    const radius = controller.camera.radius;
    const target3d = controller.camera.target.clone();

    controller.setMode("2d");
    const exported = controller.exportSessionState();

    const remounted = createEditorCamera(scene, { mode: "2d" });
    remounted.importSessionState(exported);

    expect(remounted.camera.target.x).toBeCloseTo(target2d.x, 5);
    expect(remounted.camera.target.y).toBeCloseTo(target2d.y, 5);
    expect(remounted.orthoHalfHeight()).toBeCloseTo(halfHeight, 5);

    remounted.setMode("3d");
    expect(remounted.camera.alpha).toBeCloseTo(alpha, 5);
    expect(remounted.camera.beta).toBeCloseTo(beta, 5);
    expect(remounted.camera.radius).toBeCloseTo(radius, 5);
    expect(remounted.camera.target.x).toBeCloseTo(target3d.x, 5);
    expect(remounted.camera.target.y).toBeCloseTo(target3d.y, 5);
    expect(remounted.camera.target.z).toBeCloseTo(target3d.z, 5);
  });

  it("leaves a default camera alone when importing null session state", () => {
    const { scene } = createHandle();
    const controller = createEditorCamera(scene, { mode: "3d" });
    const alpha = controller.camera.alpha;
    const beta = controller.camera.beta;
    const radius = controller.camera.radius;
    const target = controller.camera.target.clone();

    controller.importSessionState(null);

    expect(controller.camera.alpha).toBeCloseTo(alpha, 5);
    expect(controller.camera.beta).toBeCloseTo(beta, 5);
    expect(controller.camera.radius).toBeCloseTo(radius, 5);
    expect(controller.camera.target.x).toBeCloseTo(target.x, 5);
    expect(controller.camera.target.y).toBeCloseTo(target.y, 5);
    expect(controller.camera.target.z).toBeCloseTo(target.z, 5);
  });
});

describe("EditorSceneSync", () => {
  it("creates, updates and removes meshes incrementally", () => {
    const { scene } = createHandle();
    const sync = new EditorSceneSync(scene);

    sync.apply(
      sceneWith([
        createActor("a", "A", { components: [createMeshComponent("c1", "box")] }),
        createActor("b", "B"),
      ]),
    );
    const meshA = sync.meshForActor("a");
    expect(meshA).not.toBeNull();
    expect(sync.actorCount()).toBe(2);

    sync.apply(
      sceneWith([
        createActor("a", "A", {
          transform: {
            position: [4, 0, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
          components: [createMeshComponent("c1", "box")],
        }),
      ]),
    );

    // The surviving actor keeps its mesh instead of being rebuilt.
    expect(sync.meshForActor("a")).toBe(meshA);
    expect(meshA!.position.x).toBe(4);
    expect(sync.meshForActor("b")).toBeNull();
    expect(sync.actorCount()).toBe(1);
  });

  it("rebuilds a mesh when its mesh kind changes", () => {
    const { scene } = createHandle();
    const sync = new EditorSceneSync(scene);
    sync.apply(
      sceneWith([
        createActor("a", "A", { components: [createMeshComponent("c1", "box")] }),
      ]),
    );
    const before = sync.meshForActor("a");
    sync.apply(
      sceneWith([
        createActor("a", "A", {
          components: [createMeshComponent("c1", "sphere")],
        }),
      ]),
    );
    expect(sync.meshForActor("a")).not.toBe(before);
  });

  it("rebuilds a box proxy into a light billboard when LightComponent is added", () => {
    const { scene } = createHandle();
    const sync = new EditorSceneSync(scene);
    sync.apply(sceneWith([createActor("a", "A")]));
    const before = sync.meshForActor("a");
    expect(before!.billboardMode).toBe(Mesh.BILLBOARDMODE_NONE);
    sync.apply(
      sceneWith([
        createActor("a", "A", {
          components: [
            {
              id: "light",
              classId: "LightComponent",
              properties: { intensity: 1, color: [0, 1, 0.4], lightKind: "point" },
            },
          ],
        }),
      ]),
    );
    const after = sync.meshForActor("a");
    expect(after).not.toBe(before);
    expect(after!.billboardMode).toBe(Mesh.BILLBOARDMODE_ALL);
    expect(
      (after!.metadata as { editorBillboard?: string }).editorBillboard,
    ).toBe("light");
  });

  it("tints an existing light billboard without rebuilding the mesh", () => {
    const { scene } = createHandle();
    const sync = new EditorSceneSync(scene);
    sync.apply(
      sceneWith([
        createActor("a", "A", {
          components: [
            {
              id: "light",
              classId: "LightComponent",
              properties: { intensity: 1, color: [1, 1, 1], lightKind: "point" },
            },
          ],
        }),
      ]),
    );
    const mesh = sync.meshForActor("a");
    sync.apply(
      sceneWith([
        createActor("a", "A", {
          components: [
            {
              id: "light",
              classId: "LightComponent",
              properties: { intensity: 1, color: [1, 0, 0], lightKind: "point" },
            },
          ],
        }),
      ]),
    );
    expect(sync.meshForActor("a")).toBe(mesh);
    const material = mesh!.material as StandardMaterial;
    expect(material.emissiveColor.r).toBeCloseTo(1);
    expect(material.emissiveColor.g).toBeCloseTo(0);
    expect(material.emissiveColor.b).toBeCloseTo(0);
  });

  it("rebuilds a box proxy into a sprite quad when SpriteComponent is added", () => {
    const { scene } = createHandle();
    const sync = new EditorSceneSync(scene);
    sync.apply(sceneWith([createActor("a", "A")]));
    const before = sync.meshForActor("a");
    sync.apply(
      sceneWith([
        createActor("a", "A", {
          components: [
            {
              id: "sprite",
              classId: "SpriteComponent",
              properties: { assetGuid: null, sortingLayer: "Default", orderInLayer: 0 },
            },
          ],
        }),
      ]),
    );
    const after = sync.meshForActor("a");
    expect(after).not.toBe(before);
    expect(after?.name).toContain("a");
  });

  it("applies and updates parenting", () => {
    const { scene } = createHandle();
    const sync = new EditorSceneSync(scene);
    sync.apply(
      sceneWith([
        createActor("parent", "Parent"),
        createActor("child", "Child", { parentId: "parent" }),
      ]),
    );
    expect(sync.meshForActor("child")!.parent).toBe(sync.meshForActor("parent"));

    sync.apply(
      sceneWith([createActor("parent", "Parent"), createActor("child", "Child")]),
    );
    expect(sync.meshForActor("child")!.parent).toBeNull();
  });

  it("maps a picked mesh name back to its actor", () => {
    const { scene } = createHandle();
    const sync = new EditorSceneSync(scene);
    sync.apply(sceneWith([createActor("a", "A")]));
    expect(sync.actorForMesh(editorMeshName("a"))).toBe("a");
    expect(sync.actorForMesh(editorMeshName("missing"))).toBeNull();
    expect(sync.actorForMesh("actor-2")).toBeNull();
  });

  it("marks the viewport dirty on every applied edit", () => {
    const { scene } = createHandle();
    const scheduler = new RenderScheduler();
    const invalidate = vi.spyOn(scheduler, "invalidate");
    const sync = new EditorSceneSync(scene, scheduler);
    sync.apply(sceneWith([createActor("a", "A")]));
    expect(invalidate).toHaveBeenCalledWith("asset");
  });

  it("disposes every mesh it owns", () => {
    const { scene } = createHandle();
    const sync = new EditorSceneSync(scene);
    sync.apply(sceneWith([createActor("a", "A"), createActor("b", "B")]));
    sync.dispose();
    expect(sync.actorCount()).toBe(0);
    expect(scene.getMeshByName(editorMeshName("a"))).toBeNull();
  });
});

describe("editor grid", () => {
  it("registers a GLES shader without the WebGL1 derivatives extension", () => {
    const { scene } = createHandle();
    const grid = createEditorGrid(scene, { mode: "3d" });
    const fragment = Effect.ShadersStore.editorGridFragmentShader;
    expect(fragment).toBeDefined();
    expect(fragment).not.toMatch(/GL_OES_standard_derivatives/);
    expect(fragment).toContain("fwidth");
    grid.dispose();
  });

  it("snaps the plane origin to the camera target on the grid plane", () => {
    expect(snapGridOrigin("3d", { x: 3.6, y: 10, z: -1.4 }, 1)).toEqual({
      x: 4,
      y: 0,
      z: -1,
    });
    expect(snapGridOrigin("2d", { x: 3.6, y: -1.4, z: 8 }, 2)).toEqual({
      x: 4,
      y: -2,
      z: 0,
    });
  });

  it("sizes coverage from the ortho frustum in 2D and radius in 3D", () => {
    expect(
      gridCoverageWorld("2d", { radius: 8, orthoTop: 5, orthoRight: 8 }),
    ).toBe(32);
    expect(
      gridCoverageWorld("3d", { radius: 10, orthoTop: null, orthoRight: null }),
    ).toBe(80);
  });

  it("lays the grid on XZ in 3D and XY in 2D without a finite line mesh", () => {
    const { scene } = createHandle();
    const threeD = createEditorGrid(scene, { mode: "3d" });
    expect(threeD.mesh.isPickable).toBe(false);
    expect(threeD.mesh.rotation.x).toBeCloseTo(Math.PI / 2);
    expect(scene.getMeshByName("__editor-grid-minor__")).toBeNull();
    threeD.dispose();

    const twoD = createEditorGrid(scene, { mode: "2d" });
    expect(twoD.mesh.rotation.x).toBeCloseTo(0);
    twoD.dispose();
  });

  it("follows the editor camera so the plane covers the view", () => {
    const { scene } = createHandle();
    const camera = createEditorCamera(scene, { mode: "3d" });
    camera.camera.setTarget(new Vector3(40, 2, 40));
    const grid = createEditorGrid(scene, {
      mode: "3d",
      camera: camera.camera,
      spacing: 1,
    });
    grid.sync();
    expect(grid.mesh.position.x).toBe(40);
    expect(grid.mesh.position.z).toBe(40);
    expect(grid.mesh.scaling.x).toBeGreaterThan(8);
    grid.dispose();
  });

  it("hides the grid without hiding 2D camera bounds", () => {
    const { scene } = createHandle();
    const grid = createEditorGrid(scene, { mode: "2d" });
    grid.setCameraBounds({ width: 10, height: 6 });
    expect(scene.getMeshByName("__editor-camera-bounds__")).not.toBeNull();

    grid.setVisible(false);
    expect(grid.mesh.isVisible).toBe(false);
    expect(grid.boundsMesh?.isVisible).toBe(true);

    grid.setCameraBounds(null);
    expect(scene.getMeshByName("__editor-camera-bounds__")).toBeNull();
    grid.dispose();
  });

  it("keeps camera bounds out of 3D, where the rectangle is meaningless", () => {
    const { scene } = createHandle();
    const grid = createEditorGrid(scene, { mode: "3d" });
    grid.setCameraBounds({ width: 16, height: 9 });
    expect(grid.boundsMesh).toBeNull();

    grid.setMode("2d");
    expect(grid.boundsMesh).not.toBeNull();
    grid.dispose();
  });
});

describe("selection outline", () => {
  it("outlines the selected meshes and clears the previous ones", () => {
    const { scene } = createHandle();
    const sync = new EditorSceneSync(scene);
    sync.apply(sceneWith([createActor("a", "A"), createActor("b", "B")]));
    const outline = new SelectionOutline(scene);

    outline.set([sync.meshForActor("a")]);
    expect(sync.meshForActor("a")!.renderOutline).toBe(true);

    outline.set([sync.meshForActor("b")]);
    expect(sync.meshForActor("a")!.renderOutline).toBe(false);
    expect(sync.meshForActor("b")!.renderOutline).toBe(true);
    expect(outline.selected()).toHaveLength(1);

    outline.clear();
    expect(sync.meshForActor("b")!.renderOutline).toBe(false);
  });

  it("ignores null meshes", () => {
    const { scene } = createHandle();
    const outline = new SelectionOutline(scene);
    outline.set([null, undefined]);
    expect(outline.selected()).toHaveLength(0);
  });
});

describe("gizmo host", () => {
  it("hides the axes 2D cannot use", () => {
    expect(gizmoAxisEnabledFlags("2d", "translate")).toEqual({
      position: { x: true, y: true, z: false },
      rotation: { x: false, y: false, z: false },
      scale: { x: false, y: false, z: false, uniform: false },
    });
    expect(gizmoAxisEnabledFlags("2d", "rotate")).toEqual({
      position: { x: false, y: false, z: false },
      rotation: { x: false, y: false, z: true },
      scale: { x: false, y: false, z: false, uniform: false },
    });
    expect(gizmoAxisEnabledFlags("2d", "scale")).toEqual({
      position: { x: false, y: false, z: false },
      rotation: { x: false, y: false, z: false },
      scale: { x: true, y: true, z: false, uniform: true },
    });
    expect(gizmoAxisEnabledFlags("3d", "translate").position.z).toBe(true);
    expect(gizmoAxisEnabledFlags("3d", "rotate").rotation.x).toBe(true);
  });

  it("applies 2D axis flags to the live Babylon gizmos", () => {
    const { scene } = createHandle();
    const host = createGizmoHost(scene, { mode: "2d", tool: "translate" });
    expect(host.mode).toBe("2d");
    host.setTool("rotate");
    expect(host.tool).toBe("rotate");
    host.setMode("3d");
    expect(host.mode).toBe("3d");
    host.dispose();
  });

  it("attaches to a mesh only for the active tool", () => {
    const { scene } = createHandle();
    const sync = new EditorSceneSync(scene);
    sync.apply(sceneWith([createActor("a", "A")]));
    const host = createGizmoHost(scene, { tool: "translate" });

    host.attachTo(sync.meshForActor("a"));
    expect(host.attachedMesh()).toBe(sync.meshForActor("a"));

    host.setTool("none");
    expect(host.attachedMesh()).toBe(sync.meshForActor("a"));

    host.attachTo(null);
    expect(host.attachedMesh()).toBeNull();
    host.dispose();
  });

  it("reports isDragging as false until a handle drag starts", () => {
    const { scene } = createHandle();
    const host = createGizmoHost(scene);
    expect(host.isDragging()).toBe(false);
    expect(host.hitTest(0, 0)).toBe(false);
    host.dispose();
  });

  it("converts snap settings to gizmo distances", () => {
    const { scene } = createHandle();
    const host = createGizmoHost(scene);
    host.setSnap({ enabled: true, translate: 0.5, rotateDeg: 90, scale: 0.25 });
    host.setSnap({ enabled: false, translate: 0.5, rotateDeg: 90, scale: 0.25 });
    host.dispose();
  });

  it("styles axis handles unlit with shared X/Y/Z colors", () => {
    const { scene } = createHandle();
    const host = createGizmoHost(scene);
    const x = host.positionGizmo.xGizmo;
    const y = host.positionGizmo.yGizmo;
    const z = host.positionGizmo.zGizmo;
    expect(x.coloredMaterial.disableLighting).toBe(true);
    expect(y.coloredMaterial.disableLighting).toBe(true);
    expect(z.coloredMaterial.disableLighting).toBe(true);
    expect(x.coloredMaterial.emissiveColor.r).toBeCloseTo(GIZMO_AXIS_COLORS.x.r);
    expect(y.coloredMaterial.emissiveColor.g).toBeCloseTo(GIZMO_AXIS_COLORS.y.g);
    expect(z.coloredMaterial.emissiveColor.b).toBeCloseTo(GIZMO_AXIS_COLORS.z.b);
    expect(x.hoverMaterial.disableLighting).toBe(true);
    expect(x.hoverMaterial.emissiveColor.r).toBeGreaterThan(
      x.coloredMaterial.emissiveColor.r - 0.001,
    );
    expect(host.positionGizmo.xPlaneGizmo.coloredMaterial.alpha).toBeLessThan(0.25);
    expect(host.positionGizmo.xPlaneGizmo.coloredMaterial.alpha).toBeGreaterThan(
      0.1,
    );
    host.dispose();
  });

  it("keeps the uniform scale handle small and does not inject a custom cube", () => {
    const { scene } = createHandle();
    const sync = new EditorSceneSync(scene);
    sync.apply(sceneWith([createActor("a", "A")]));
    const host = createGizmoHost(scene, { tool: "scale" });
    host.attachTo(sync.meshForActor("a"));

    const layerScene = host.scaleGizmo.uniformScaleGizmo.gizmoLayer.utilityLayerScene;
    expect(layerScene.getMeshByName("gizmo-uniform-scale")).toBeNull();

    const root = host.scaleGizmo.uniformScaleGizmo._rootMesh;
    root.computeWorldMatrix(true);
    const rootScale = Math.max(
      Math.abs(root.absoluteScaling.x),
      Math.abs(root.absoluteScaling.y),
      Math.abs(root.absoluteScaling.z),
      1e-6,
    );
    let maxHalfExtent = 0;
    for (const mesh of root.getChildMeshes()) {
      if (mesh.visibility <= 0) continue;
      mesh.computeWorldMatrix(true);
      mesh.refreshBoundingInfo(false, false);
      const size = mesh.getBoundingInfo().boundingBox.extendSizeWorld;
      maxHalfExtent = Math.max(maxHalfExtent, size.x, size.y, size.z);
    }
    const relativeExtent = (maxHalfExtent * 2) / rootScale;
    expect(relativeExtent).toBeGreaterThan(0);
    expect(relativeExtent).toBeLessThan(0.05);
    host.dispose();
  });

  it("styles the uniform scale handle unlit with a light-gray emissive", () => {
    const { scene } = createHandle();
    const host = createGizmoHost(scene, { tool: "scale" });
    const { coloredMaterial, hoverMaterial } = host.scaleGizmo;
    const uniform = host.scaleGizmo.uniformScaleGizmo;
    expect(coloredMaterial.disableLighting).toBe(true);
    expect(hoverMaterial.disableLighting).toBe(true);
    expect(uniform.coloredMaterial.disableLighting).toBe(true);
    expect(uniform.hoverMaterial.disableLighting).toBe(true);
    expect(coloredMaterial.emissiveColor.r).toBeCloseTo(GIZMO_UNIFORM_COLOR.r);
    expect(coloredMaterial.emissiveColor.g).toBeCloseTo(GIZMO_UNIFORM_COLOR.g);
    expect(coloredMaterial.emissiveColor.b).toBeCloseTo(GIZMO_UNIFORM_COLOR.b);
    expect(uniform.coloredMaterial.emissiveColor.r).toBeCloseTo(
      GIZMO_UNIFORM_COLOR.r,
    );
    expect(hoverMaterial.emissiveColor.r).toBeGreaterThan(
      coloredMaterial.emissiveColor.r - 0.001,
    );
    host.dispose();
  });

  it("uses a mid-size default handle scale on every tool", () => {
    const { scene } = createHandle();
    const host = createGizmoHost(scene);
    // 2.4 filled too little of the view; 3.6 filled too much.
    expect(DEFAULT_GIZMO_HANDLE_SCALE).toBe(2.8);
    expect(host.positionGizmo.scaleRatio).toBe(DEFAULT_GIZMO_HANDLE_SCALE);
    expect(host.rotationGizmo.scaleRatio).toBe(DEFAULT_GIZMO_HANDLE_SCALE);
    expect(host.scaleGizmo.scaleRatio).toBe(DEFAULT_GIZMO_HANDLE_SCALE);
    host.dispose();
  });

  it("enlarges leaf collider meshes past the visible shafts", () => {
    const { scene } = createHandle();
    const host = createGizmoHost(scene);
    const children = host.positionGizmo.xGizmo._rootMesh.getChildMeshes();
    const visualShaft = children.find(
      (mesh) =>
        mesh.name === "cylinder" &&
        mesh.visibility > 0 &&
        Math.abs(mesh.position.z - 0.3) > 0.05,
    );
    const colliderShaft = children.find(
      (mesh) =>
        mesh.name === "cylinder" &&
        mesh.visibility === 0 &&
        mesh.getChildMeshes().length === 0 &&
        Math.abs(mesh.position.z - 0.3) > 0.05,
    );
    expect(visualShaft).toBeDefined();
    expect(colliderShaft).toBeDefined();
    expect(colliderShaft!.scaling.x / visualShaft!.scaling.x).toBeCloseTo(
      GIZMO_COLLIDER_SCALE,
    );
    host.dispose();
  });

  it("enlarges visible translate cones and scale boxes, not shafts", () => {
    const { scene } = createHandle();
    const host = createGizmoHost(scene);
    const translate = host.positionGizmo.xGizmo._rootMesh.getChildMeshes();
    const cone = translate.find(
      (mesh) =>
        mesh.name === "cylinder" &&
        mesh.visibility > 0 &&
        Math.abs(mesh.position.z - 0.3) < 0.02,
    );
    const shaft = translate.find(
      (mesh) =>
        mesh.name === "cylinder" &&
        mesh.visibility > 0 &&
        Math.abs(mesh.position.z - 0.3) > 0.05,
    );
    expect(cone).toBeDefined();
    expect(shaft).toBeDefined();
    expect(cone!.scaling.x).toBeCloseTo(GIZMO_END_CAP_SCALE);
    expect(shaft!.scaling.x).toBeCloseTo(1);

    const scaleAxis = host.scaleGizmo.xGizmo._rootMesh.getChildMeshes();
    const box = scaleAxis.find(
      (mesh) => mesh.name === "yPosMesh" && mesh.visibility > 0,
    );
    expect(box).toBeDefined();
    expect(box!.scaling.x).toBeCloseTo(0.1 * GIZMO_END_CAP_SCALE);
    host.dispose();
  });
});
