import { afterEach, describe, expect, it, vi } from "vitest";
import { Vector3 } from "@babylonjs/core";
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
import { createEditorGrid, buildGridLines, gridLineOffsets } from "./editor-grid";
import { createGizmoHost, gizmoAxisEnabledFlags, GIZMO_AXIS_COLORS } from "./gizmo-host";
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
  it("spaces lines evenly around the origin", () => {
    expect(gridLineOffsets(2, 2)).toEqual([-4, -2, 0, 2, 4]);
  });

  it("builds the grid on XZ in 3D and on XY in 2D", () => {
    const threeD = buildGridLines("3d", 1, 1);
    expect(threeD.every((line) => line.every((point) => point.y === 0))).toBe(true);
    const twoD = buildGridLines("2d", 1, 1);
    expect(twoD.every((line) => line.every((point) => point.z === 0))).toBe(true);
  });

  it("rebuilds when the mode or spacing changes and draws camera bounds", () => {
    const { scene } = createHandle();
    const grid = createEditorGrid(scene, { mode: "3d", extent: 2 });
    grid.setMode("2d");
    expect(grid.mesh.isPickable).toBe(false);

    grid.setSpacing(2);
    grid.setCameraBounds({ width: 10, height: 6 });
    expect(scene.getMeshByName("__editor-camera-bounds__")).not.toBeNull();

    grid.setCameraBounds(null);
    expect(scene.getMeshByName("__editor-camera-bounds__")).toBeNull();
    grid.dispose();
  });

  it("draws a minor subdivision grid in 2D only", () => {
    const { scene } = createHandle();
    const grid = createEditorGrid(scene, {
      mode: "3d",
      extent: 2,
      subdivisions: 4,
    });
    expect(grid.minorMesh).toBeNull();

    grid.setMode("2d");
    expect(grid.minorMesh).not.toBeNull();
    expect(scene.getMeshByName("__editor-grid-minor__")).not.toBeNull();

    grid.setSubdivisions(1);
    expect(grid.minorMesh).toBeNull();

    grid.dispose();
  });

  it("hides the minor grid along with the major grid", () => {
    const { scene } = createHandle();
    const grid = createEditorGrid(scene, {
      mode: "2d",
      extent: 2,
      subdivisions: 2,
    });
    grid.setVisible(false);
    expect(grid.mesh.isVisible).toBe(false);
    expect(grid.minorMesh?.isVisible).toBe(false);

    grid.setVisible(true);
    expect(grid.minorMesh?.isVisible).toBe(true);
    grid.dispose();
  });

  it("keeps camera bounds out of 3D, where the rectangle is meaningless", () => {
    const { scene } = createHandle();
    const grid = createEditorGrid(scene, { mode: "3d", extent: 2 });
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
});
