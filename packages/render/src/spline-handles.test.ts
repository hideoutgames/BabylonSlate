import { describe, expect, it } from "vitest";
import { FreeCamera, NullEngine, PointerDragBehavior, Scene, UtilityLayerRenderer, Vector3 } from "@babylonjs/core";
import { createActor, createDefaultScene, parseSplineProperties } from "@babylonslate/core";
import { createSplineHandles, insertSplinePoint, removeSplinePoint, splineHandles } from "./spline-handles";
import { createSplineMesh, splineMeshBody } from "./spline-mesh";
import { selectedShapeComponent } from "./shape-edit-target";

const event = (point: Vector3) => ({ dragPlanePoint: point, pointerId: 1, pointerInfo: null, dragPlaneNormal: Vector3.Forward(), dragDistance: 0, delta: Vector3.Zero() });

describe("Spline shape handles", () => {
  it("inserts along the closing segment and preserves the closed path's minimum points", () => {
    const body = parseSplineProperties({ points: [[0, 0, 0], [6, 0, 0], [0, 8, 0]], curvature: 0, closed: true });
    expect(splineHandles(body).find((handle) => handle.id === "insert:2")?.position).toEqual([0, 4, 0]);
    const inserted = parseSplineProperties({ ...body, ...insertSplinePoint(body, 2, [1, 4, 2]) });
    expect(inserted.points).toEqual([[0, 0, 0], [6, 0, 0], [0, 8, 0], [1, 4, 2]]);
    expect(removeSplinePoint(inserted, 3)?.points).toEqual(body.points);
    expect(removeSplinePoint(body, 0)).toBeNull();
  });

  it("updates point drag planes when the render camera turns", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    const camera = new FreeCamera("camera", new Vector3(0, 10, -20), scene);
    camera.setTarget(Vector3.Zero());
    const layer = new UtilityLayerRenderer(scene);
    const handles = createSplineHandles(layer, scene);
    try {
      const properties = { points: [[0, 0, 0], [0, 0, 10]], curvature: 0 };
      createSplineMesh(scene, "curve", properties);
      handles.attach({ actorId: "actor", componentId: "spline", meshName: "curve", properties });
      layer.utilityLayerScene.render();
      const pick = layer.utilityLayerScene.getMeshByName("spline-handle:point:1")!;
      const drag = pick.getBehaviorByName("PointerDrag") as PointerDragBehavior;
      const before = drag.options.dragPlaneNormal!.clone().normalize();
      camera.setTarget(new Vector3(10, 0, 0));
      camera.getViewMatrix(true);
      layer.utilityLayerScene.render();
      const after = drag.options.dragPlaneNormal!.clone().normalize();
      const expected = camera.getForwardRay().direction.normalize();
      expect(Math.abs(Vector3.Dot(after, expected))).toBeCloseTo(1, 6);
      expect(Math.abs(Vector3.Dot(after, before))).toBeLessThan(0.99);
    } finally { handles.dispose(); layer.dispose(); scene.dispose(); engine.dispose(); }
  });

  it("moves full XYZ in component space, previews without committing, and rolls back cancelled drags", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    const camera = new FreeCamera("camera", new Vector3(0, 10, -20), scene);
    camera.setTarget(Vector3.Zero());
    const layer = new UtilityLayerRenderer(scene);
    const commits: unknown[] = [];
    const handles = createSplineHandles(layer, scene, { onCommit: (edit) => commits.push(edit) });
    try {
      const properties = { points: [[0, 0, 0], [0, 0, 10]], curvature: 0, label: "retain me" };
      const mesh = createSplineMesh(scene, "curve", properties);
      mesh.position.set(20, 1, 0); mesh.scaling.set(2, 3, 4); mesh.rotation.y = Math.PI / 2;
      handles.attach({ actorId: "actor", componentId: "spline", meshName: "curve", properties });
      layer.utilityLayerScene.render();
      const pick = layer.utilityLayerScene.getMeshByName("spline-handle:point:1")!;
      const drag = pick.getBehaviorByName("PointerDrag") as PointerDragBehavior;
      expect(drag.options.dragPlaneNormal?.equalsWithEpsilon(camera.getForwardRay().direction)).toBe(true);
      drag.onDragStartObservable.notifyObservers(event(pick.position.clone()) as never);
      drag.onDragObservable.notifyObservers(event(new Vector3(48, 16, -6)) as never);
      const point = splineMeshBody(mesh)!.points[1]!;
      expect(point[0]).toBeCloseTo(3); expect(point[1]).toBeCloseTo(5); expect(point[2]).toBeCloseTo(7);
      expect(commits).toEqual([]);
      drag.onDragEndObservable.notifyObservers(event(new Vector3(48, 16, -6)) as never);
      expect(commits).toHaveLength(1);
      expect(commits[0]).toMatchObject({ actorId: "actor", componentId: "spline", properties: { label: "retain me", curvature: 0 } });
      drag.onDragStartObservable.notifyObservers(event(new Vector3(48, 16, -6)) as never);
      drag.onDragObservable.notifyObservers(event(new Vector3(24, 7, -4)) as never);
      handles.attach(null);
      expect(splineMeshBody(mesh)!.points[1]).toEqual(point);
      expect(commits).toHaveLength(1);
      expect(handles.handleIds()).toEqual([]);
    } finally { handles.dispose(); layer.dispose(); scene.dispose(); engine.dispose(); }
  });

  it("keeps an insertion drag active when its new point changes the handle topology", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    new FreeCamera("camera", new Vector3(0, 10, -20), scene);
    const layer = new UtilityLayerRenderer(scene), commits: unknown[] = [];
    const handles = createSplineHandles(layer, scene, { onCommit: (edit) => commits.push(edit) });
    try {
      const properties = { points: [[0, 0, 0], [0, 0, 10]], curvature: 0 };
      const mesh = createSplineMesh(scene, "curve", properties);
      handles.attach({ actorId: "actor", componentId: "spline", meshName: "curve", properties });
      const pick = layer.utilityLayerScene.getMeshByName("spline-handle:insert:0")!;
      const drag = pick.getBehaviorByName("PointerDrag") as PointerDragBehavior;
      drag.onDragStartObservable.notifyObservers(event(new Vector3(0, 0, 5)) as never);
      drag.onDragObservable.notifyObservers(event(new Vector3(2, 3, 5)) as never);
      layer.utilityLayerScene.render();
      expect(pick.isDisposed()).toBe(false);
      drag.onDragObservable.notifyObservers(event(new Vector3(4, 6, 5)) as never);
      drag.onDragEndObservable.notifyObservers(event(new Vector3(4, 6, 5)) as never);
      expect(splineMeshBody(mesh)!.points).toEqual([[0, 0, 0], [4, 6, 5], [0, 0, 10]]);
      expect(commits).toHaveLength(1);
    } finally { handles.dispose(); layer.dispose(); scene.dispose(); engine.dispose(); }
  });

  it("selects a clicked point for the gizmo and commits gizmo moves once", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    new FreeCamera("camera", new Vector3(0, 10, -20), scene);
    const layer = new UtilityLayerRenderer(scene), commits: unknown[] = [];
    let changes = 0;
    const handles = createSplineHandles(layer, scene, { onCommit: (edit) => commits.push(edit), onSelectionChange: () => changes++ });
    try {
      const properties = { points: [[0, 0, 0], [0, 0, 10]], curvature: 0 };
      const mesh = createSplineMesh(scene, "curve", properties);
      mesh.position.set(5, 0, 0);
      handles.attach({ actorId: "actor", componentId: "spline", meshName: "curve", properties });
      layer.utilityLayerScene.render();
      expect(handles.selectedNode()).toBeNull();
      expect(handles.beginSelectionDrag()).toBe(false);
      const pick = layer.utilityLayerScene.getMeshByName("spline-handle:point:1")!;
      const drag = pick.getBehaviorByName("PointerDrag") as PointerDragBehavior;
      drag.onDragStartObservable.notifyObservers(event(pick.position.clone()) as never);
      drag.onDragEndObservable.notifyObservers(event(pick.position.clone()) as never);
      const node = handles.selectedNode()!;
      expect(changes).toBe(1);
      expect(node.isPickable).toBe(false);
      expect(node.getAbsolutePosition().equalsWithEpsilon(new Vector3(5, 0, 10))).toBe(true);
      expect(commits).toEqual([]);

      expect(handles.beginSelectionDrag()).toBe(true);
      node.setAbsolutePosition(new Vector3(8, 4, 10));
      handles.dragSelection();
      expect(splineMeshBody(mesh)!.points[1]).toEqual([3, 4, 10]);
      expect(commits).toEqual([]);
      handles.endSelectionDrag();
      expect(commits).toHaveLength(1);
      expect(handles.selectedNode()).toBe(node);
      layer.utilityLayerScene.render();
      expect(node.getAbsolutePosition().equalsWithEpsilon(new Vector3(8, 4, 10))).toBe(true);

      handles.clearSelection();
      expect(handles.selectedNode()).toBeNull();
      expect(node.isDisposed()).toBe(true);
      expect(changes).toBe(2);
    } finally { handles.dispose(); layer.dispose(); scene.dispose(); engine.dispose(); }
  });

  it("edits the selected component and detaches for locked or ambiguous selections", () => {
    const actor = createActor("a", "Path", { components: [
      { id: "river", classId: "WaterRiverComponent", properties: {} },
      { id: "curve", classId: "SplineComponent", properties: {} },
      { id: "mesh", classId: "MeshComponent", properties: {} },
    ] });
    const scene = { ...createDefaultScene(), actors: [actor] };
    expect(selectedShapeComponent(scene, ["a"], ["curve"])?.component.id).toBe("curve");
    expect(selectedShapeComponent(scene, ["a"], [])?.component.id).toBe("river");
    expect(selectedShapeComponent(scene, ["a"], ["mesh"])).toBeNull();
    expect(selectedShapeComponent(scene, ["a"], ["river", "curve"])).toBeNull();
    expect(selectedShapeComponent(scene, [], ["curve"])).toBeNull();
    expect(selectedShapeComponent(scene, ["a", "b"], [])).toBeNull();
    expect(selectedShapeComponent({ ...scene, actors: [{ ...actor, locked: true }] }, ["a"], ["curve"])).toBeNull();
  });
});
