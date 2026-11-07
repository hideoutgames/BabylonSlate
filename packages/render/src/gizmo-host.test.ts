import { afterEach, describe, expect, it, vi } from "vitest";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Scene } from "@babylonjs/core/scene";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Material } from "@babylonjs/core/Materials/material";
import { createTestEngine } from "./test-support/test-engine";
import {
  clampGizmoScreenScale,
  createGizmoHost,
  GIZMO_MIN_CAMERA_DISTANCE,
  GIZMO_PLANAR_HOVER_ALPHA,
  GIZMO_PLANAR_IDLE_ALPHA,
} from "./gizmo-host";
import { linkedAxisScale } from "./linked-axis-scale";
import { isUnlitMaterial } from "./unlit-material";
import { unlitBinding } from "./unlit-material-blocks";

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
    // Float drift on an axis the X handle does not move must not snap it.
    mesh.position.y += 1e-6;
    mesh.computeWorldMatrix(true);
    drag.onDragObservable.notifyObservers(event(0.3));
    expect(mesh.position.x).toBeCloseTo(1);
    expect(mesh.position.y).toBe(0.25);
    host.dispose();
  });
});

describe("linked scale gizmo", () => {
  const dragX = (
    host: ReturnType<typeof createGizmoHost>,
    distances: readonly number[],
  ) => {
    const drag = host.scaleGizmo.xGizmo.dragBehavior;
    drag.onDragStartObservable.notifyObservers({
      dragPlanePoint: Vector3.Zero(),
      pointerId: 1,
      pointerInfo: null,
    });
    for (const distance of distances) {
      drag.onDragObservable.notifyObservers({
        delta: new Vector3(distance, 0, 0),
        dragPlanePoint: Vector3.Zero(),
        dragPlaneNormal: Vector3.Forward(),
        dragDistance: distance,
        pointerId: 1,
        pointerInfo: null,
      });
    }
    drag.onDragEndObservable.notifyObservers({
      dragPlanePoint: Vector3.Zero(),
      pointerId: 1,
      pointerInfo: null,
    });
  };
  const scaledBox = (scene: Scene, mode: "2d" | "3d", linked: boolean) => {
    scene.activeCamera = new FreeCamera("cam", new Vector3(0, 0, -10), scene);
    const mesh = MeshBuilder.CreateBox("box", { size: 1 }, scene);
    mesh.rotation.y = 0.4;
    mesh.scaling.set(1, 2, 4);
    mesh.computeWorldMatrix(true);
    const host = createGizmoHost(scene, { tool: "scale", mode });
    host.setLinkedScale(linked);
    host.attachTo(mesh);
    return { mesh, host };
  };

  it("scales the other axes by the dragged axis's factor while linked", () => {
    const { scene } = createHandle();
    const { mesh, host } = scaledBox(scene, "3d", true);
    dragX(host, [0.2, 0.3]);
    const factor = mesh.scaling.x;
    expect(factor).toBeGreaterThan(1.05);
    expect(mesh.scaling.y).toBeCloseTo(2 * factor, 5);
    expect(mesh.scaling.z).toBeCloseTo(4 * factor, 5);
    host.dispose();
  });

  it("keeps Z in 2D and follows snapped steps of the dragged axis", () => {
    const { scene } = createHandle();
    const { mesh, host } = scaledBox(scene, "2d", true);
    host.setSnap({ enabled: true, translate: 1, rotateDeg: 15, scale: 0.5 });
    dragX(host, [4]);
    const steps = (mesh.scaling.x - 1) / 0.5;
    expect(steps).toBeGreaterThanOrEqual(1);
    expect(steps).toBeCloseTo(Math.round(steps), 5);
    expect(mesh.scaling.y).toBeCloseTo(2 * mesh.scaling.x, 5);
    expect(mesh.scaling.z).toBeCloseTo(4, 5);
    host.dispose();
  });

  it("scales only the dragged axis when not linked", () => {
    const { scene } = createHandle();
    const { mesh, host } = scaledBox(scene, "3d", false);
    dragX(host, [0.2, 0.3]);
    expect(mesh.scaling.x).toBeGreaterThan(1.05);
    expect(mesh.scaling.y).toBeCloseTo(2, 5);
    expect(mesh.scaling.z).toBeCloseTo(4, 5);
    host.dispose();
  });
});

describe("linkedAxisScale", () => {
  it.each([
    { start: [1, 2, 4], axis: 0, value: 3, mode: "3d", expected: [3, 6, 12] },
    { start: [2, 4, 8], axis: 1, value: 2, mode: "3d", expected: [1, 2, 4] },
    { start: [1, 2, 4], axis: 0, value: 3, mode: "2d", expected: [3, 6, 4] },
    { start: [0, 2, 4], axis: 0, value: 1.5, mode: "3d", expected: [1.5, 1.5, 1.5] },
    { start: [-1, 2, 4], axis: 0, value: -2, mode: "3d", expected: [-2, 4, 8] },
  ] as const)("$start, axis $axis to $value in $mode → $expected", ({ start, axis, value, mode, expected }) => {
    expect(linkedAxisScale(start, axis, value, mode)).toEqual(expected);
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

describe("gizmo materials", () => {
  it("draws every handle with unlit Materials, idle, hover and disabled each its own colour", () => {
    const { scene } = createHandle();
    new FreeCamera("camera", new Vector3(0, 0, -10), scene);
    const host = createGizmoHost(scene, { tool: "translate" });
    const layer = host.layer.utilityLayerScene;
    // No Standard material is left in the gizmo layer: handles draw the unlit Material without fog.
    expect(layer.materials.filter((material) => material instanceof StandardMaterial && material !== layer.defaultMaterial)).toEqual([]);
    const handleMeshes = layer.meshes.filter((mesh) => mesh.material && mesh.material.getClassName() !== "ShaderMaterial");
    expect(handleMeshes.length).toBeGreaterThan(0);
    for (const mesh of handleMeshes) {
      expect(isUnlitMaterial(mesh.material), mesh.name).toBe(true);
      expect(mesh.material!.fogEnabled).toBe(false);
    }
    // Each slot binds its own fill: the planar handles' idle and hover alphas, and Babylon's disabled alpha.
    const alphas = new Set(layer.materials.filter(isUnlitMaterial).map((material) => unlitBinding({ material } as unknown as AbstractMesh).alpha));
    expect([...alphas]).toEqual(expect.arrayContaining([1, GIZMO_PLANAR_IDLE_ALPHA, GIZMO_PLANAR_HOVER_ALPHA, 0.4]));
    // Babylon's gizmos copy the material's diffuse colour to their line meshes.
    for (const material of layer.materials.filter(isUnlitMaterial)) {
      expect((material as unknown as { diffuseColor?: unknown }).diffuseColor).toBeDefined();
    }
    // Hover swaps the cached materials: each axis's idle and hover fills differ.
    const caches = (host.positionGizmo as unknown as { _gizmoAxisCache: Map<unknown, { material: Material; hoverMaterial: Material; disableMaterial: Material }> })._gizmoAxisCache;
    expect(caches.size).toBeGreaterThan(0);
    for (const cache of caches.values()) {
      for (const material of [cache.material, cache.hoverMaterial, cache.disableMaterial]) expect(isUnlitMaterial(material)).toBe(true);
      expect(unlitBinding({ material: cache.hoverMaterial } as unknown as AbstractMesh).color).not.toEqual(unlitBinding({ material: cache.material } as unknown as AbstractMesh).color);
    }
    host.dispose();
  });
});
