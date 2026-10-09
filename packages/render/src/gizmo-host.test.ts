import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FreeCamera,
  MeshBuilder,
  RenderTargetTexture,
  Scene,
  Vector3,
} from "@babylonjs/core";
import { createTestEngine } from "./create-null-engine";
import {
  clampGizmoScreenScale,
  createGizmoHost,
  GIZMO_MIN_CAMERA_DISTANCE,
} from "./gizmo-host";

const handles: Array<{
  engine: { dispose: () => void };
  scene: { dispose: () => void };
}> = [];

function createHandle() {
  const handle = createTestEngine();
  handles.push(handle);
  return handle;
}

afterEach(() => {
  while (handles.length > 0) {
    const handle = handles.pop();
    handle?.scene.dispose();
    handle?.engine.dispose();
  }
});

describe("gizmo screen-scale clamp", () => {
  it("keeps a usable scale when camera distance collapses to zero", () => {
    const ratio = 1.8;
    expect(clampGizmoScreenScale(0, ratio)).toBeCloseTo(
      ratio * GIZMO_MIN_CAMERA_DISTANCE,
    );
    expect(clampGizmoScreenScale(0.01, ratio)).toBeCloseTo(
      ratio * GIZMO_MIN_CAMERA_DISTANCE,
    );
  });

  it("preserves a healthy perspective scale and handedness", () => {
    expect(clampGizmoScreenScale(12, 1.8)).toBe(12);
    expect(clampGizmoScreenScale(-0.02, 1.8)).toBeCloseTo(
      -(1.8 * GIZMO_MIN_CAMERA_DISTANCE),
    );
  });
});

describe("gizmo tool override", () => {
  it("translates an override attachment and restores the active tool for the next one", () => {
    const { scene } = createHandle();
    scene.activeCamera = new FreeCamera("cam", new Vector3(0, 0, -10), scene);
    const point = MeshBuilder.CreateBox("point", { size: 1 }, scene);
    const actor = MeshBuilder.CreateBox("actor", { size: 1 }, scene);
    const host = createGizmoHost(scene, { tool: "rotate" });
    host.attachTo(point, [], { tool: "translate" });
    expect(host.positionGizmo.attachedMesh).toBe(point);
    expect(host.rotationGizmo.attachedMesh).toBeNull();
    host.setTool("scale");
    expect(host.positionGizmo.attachedMesh).toBe(point);
    host.attachTo(actor);
    expect(host.positionGizmo.attachedMesh).toBeNull();
    expect(host.scaleGizmo.attachedMesh).toBe(actor);
    host.dispose();
  });
});

describe("gizmo move snap", () => {
  it("lands dragged axes on the world grid and leaves other axes alone", () => {
    const { scene } = createHandle();
    const camera = new FreeCamera("cam", new Vector3(0, 0, -10), scene);
    scene.activeCamera = camera;
    const mesh = MeshBuilder.CreateBox("box", { size: 1 }, scene);
    mesh.position.set(0.3, 0.25, 0);
    const host = createGizmoHost(scene, { tool: "translate" });
    host.attachTo(mesh);
    host.setSnap({ enabled: true, translate: 1, rotateDeg: 15, scale: 0.1 });
    const drag = host.positionGizmo.xGizmo.dragBehavior;
    const event = (dx: number) => ({
      delta: new Vector3(dx, 0, 0),
      dragPlanePoint: Vector3.Zero(),
      dragPlaneNormal: Vector3.Forward(),
      dragDistance: dx,
      pointerId: 1,
      pointerInfo: null,
    });

    drag.onDragStartObservable.notifyObservers({
      dragPlanePoint: Vector3.Zero(),
      pointerId: 1,
      pointerInfo: null,
    });
    drag.onDragObservable.notifyObservers(event(0.1));
    expect(mesh.position.x).toBeCloseTo(0);
    drag.onDragObservable.notifyObservers(event(0.5));
    drag.onDragObservable.notifyObservers(event(0.3));
    expect(mesh.position.x).toBeCloseTo(1);
    expect(mesh.position.y).toBeCloseTo(0.25);
    host.dispose();
  });
});

describe("gizmo space", () => {
  it("aligns move and rotate handles to the attached mesh only in local space", () => {
    const { scene } = createHandle();
    scene.activeCamera = new FreeCamera("cam", new Vector3(0, 0, -10), scene);
    const mesh = MeshBuilder.CreateBox("box", { size: 1 }, scene);
    mesh.rotation.y = Math.PI / 2;
    mesh.computeWorldMatrix(true);
    const host = createGizmoHost(scene, { tool: "translate" });
    host.attachTo(mesh);
    const handleAxis = () => {
      host.layer.utilityLayerScene.render();
      const root = host.positionGizmo.xGizmo._rootMesh;
      return Vector3.TransformNormal(
        Vector3.Right(),
        root.computeWorldMatrix(true),
      ).normalize();
    };

    expect(host.space).toBe("world");
    expect(handleAxis().x).toBeCloseTo(1);

    host.setSpace("local");
    const local = handleAxis();
    expect(local.x).toBeCloseTo(0);
    expect(Math.abs(local.z)).toBeCloseTo(1);
    expect(host.rotationGizmo.updateGizmoRotationToMatchAttachedMesh).toBe(true);

    host.setSpace("world");
    expect(handleAxis().x).toBeCloseTo(1);
    host.dispose();
  });

  it("snaps local moves in steps from the drag start instead of to the world grid", () => {
    const { scene } = createHandle();
    scene.activeCamera = new FreeCamera("cam", new Vector3(0, 0, -10), scene);
    const mesh = MeshBuilder.CreateBox("box", { size: 1 }, scene);
    mesh.position.set(0.3, 0.25, 0);
    mesh.computeWorldMatrix(true);
    const host = createGizmoHost(scene, { tool: "translate", space: "local" });
    host.attachTo(mesh);
    host.setSnap({ enabled: true, translate: 1, rotateDeg: 15, scale: 0.1 });
    const drag = host.positionGizmo.xGizmo.dragBehavior;
    const event = (dx: number) => ({
      delta: new Vector3(dx, 0, 0),
      dragPlanePoint: Vector3.Zero(),
      dragPlaneNormal: Vector3.Forward(),
      dragDistance: dx,
      pointerId: 1,
      pointerInfo: null,
    });

    drag.onDragStartObservable.notifyObservers({
      dragPlanePoint: Vector3.Zero(),
      pointerId: 1,
      pointerInfo: null,
    });
    drag.onDragObservable.notifyObservers(event(0.5));
    expect(mesh.position.x).toBeCloseTo(0.3);
    drag.onDragObservable.notifyObservers(event(0.6));
    expect(mesh.position.x).toBeCloseTo(1.3);
    expect(mesh.position.y).toBeCloseTo(0.25);
    host.dispose();
  });
});

describe("gizmo Prefab RTT pointer mapping", () => {
  it("clears world depth before drawing gizmos into a Prefab render target", () => {
    const { scene, engine } = createHandle();
    const camera = new FreeCamera("preview", new Vector3(0, 0, -10), scene);
    scene.activeCamera = camera;
    camera.outputRenderTarget = new RenderTargetTexture("prefab", 64, scene);
    const host = createGizmoHost(scene);
    const layerScene = host.positionGizmo.gizmoLayer.utilityLayerScene;
    const clears: Array<{ color: boolean; depth: boolean; stencil: boolean }> = [];
    const clear = vi.spyOn(engine, "clear").mockImplementation((_color, color, depth, stencil) => {
      if (camera.getScene() === layerScene) clears.push({ color, depth, stencil: stencil === true });
    });

    scene.render();

    expect(clears).toContainEqual({ color: false, depth: true, stencil: true });
    expect(clears.some((entry) => entry.color)).toBe(false);
    clear.mockRestore();
    host.dispose();
  });

  it("hitTests in Engine pick space when the canvas size is not the Engine size", () => {
    const { scene, engine } = createHandle();
    vi.spyOn(engine, "getRenderWidth").mockReturnValue(800);
    vi.spyOn(engine, "getRenderHeight").mockReturnValue(400);
    const host = createGizmoHost(scene);
    const pick = vi
      .spyOn(Scene.prototype, "pick")
      .mockReturnValue({ hit: false } as never);

    host.hitTest(100, 50, { width: 200, height: 100 });

    const coords = pick.mock.calls.map((call) => [call[0], call[1]]);
    expect(coords).toContainEqual([400, 200]);
    host.dispose();
  });

  it("forwards pointer down into the scene without the Engine input canvas", () => {
    const { scene, engine } = createHandle();
    vi.spyOn(engine, "getRenderWidth").mockReturnValue(800);
    vi.spyOn(engine, "getRenderHeight").mockReturnValue(400);
    const host = createGizmoHost(scene);
    const down = vi.spyOn(scene, "simulatePointerDown");

    host.forwardPointer("down", 100, 50, { width: 200, height: 100, pointerId: 7 });

    expect(scene.pointerX).toBeCloseTo(400);
    expect(scene.pointerY).toBeCloseTo(200);
    expect(down).toHaveBeenCalled();
    const init = down.mock.calls[0]?.[1] as { pointerId?: number } | undefined;
    expect(init?.pointerId).toBe(7);
    host.dispose();
  });
});
