import { describe, expect, it, vi } from "vitest";
import { FreeCamera, NullEngine, PointerDragBehavior, Scene, UtilityLayerRenderer, Vector3 } from "@babylonjs/core";
import { normalizeWaterBody } from "@babylonslate/core";
import { createWaterMesh } from "./water-mesh";
import { createWaterHandles, dragWaterHandle, insertRiverPoint, removeRiverPoint, waterHandles } from "./water-handles";

describe("Water shape handles", () => {
  it("resizes finite volumes symmetrically and edits Depth", () => {
    const lake = normalizeWaterBody({ width: 10, length: 6, depth: 3 });
    const handle = (id: string) => waterHandles(lake).find((entry) => entry.id === id)!;
    expect(handle("width+").position).toEqual([5, 0, 0]);
    expect(dragWaterHandle(lake, handle("width-"), [-8, 0, 2])).toEqual({ width: 16 });
    expect(dragWaterHandle(lake, handle("length+"), [1, 0, 0.01])).toEqual({ length: 0.1 });
    expect(dragWaterHandle(lake, handle("depth"), [0, -4.5, 0])).toEqual({ depth: 4.5 });
    expect(waterHandles(normalizeWaterBody({}, "global")).map((entry) => entry.id)).toEqual(["depth"]);
  });

  it("moves, widens, inserts and removes river points while keeping their elevation", () => {
    const river = normalizeWaterBody({ width: 4, points: [[0, 2, 0], [0, 1, 10]] }, "river");
    const handles = waterHandles(river);
    expect(handles.map((entry) => entry.id)).toEqual(["point:0", "pointWidth:0", "insert:0", "point:1", "pointWidth:1"]);
    expect(dragWaterHandle(river, handles[3]!, [3, -9, 12]).points).toEqual([[0, 2, 0], [3, 1, 12]]);
    // The width handle sits beside its point; dragging it 4 m out doubles the point's width.
    expect(handles[1]!.position[0]).toBeCloseTo(-2);
    expect(dragWaterHandle(river, handles[1]!, [-4, 2, 0.5]).widthScales).toEqual([2, 1]);
    const inserted = normalizeWaterBody({ ...river, ...insertRiverPoint(river, 0, [2, 0, 5]) }, "river");
    expect(inserted.points).toEqual([[0, 2, 0], [2, 1.5, 5], [0, 1, 10]]);
    expect(inserted.widthScales).toEqual([1, 1, 1]);
    expect(removeRiverPoint(inserted, 1)?.points).toEqual(river.points);
    expect(removeRiverPoint(river, 0)).toBeNull();
  });

  it("reshapes the live water mesh while dragging and commits one merged property change on release", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    new FreeCamera("camera", new Vector3(0, 10, -20), scene);
    const layer = new UtilityLayerRenderer(scene);
    const commits: unknown[] = [];
    try {
      const body = normalizeWaterBody({ width: 10, length: 6 });
      const mesh = createWaterMesh(scene, "actor:lake", body);
      mesh.position.set(20, 1, 0);
      const handles = createWaterHandles(layer, scene, { onCommit: (edit) => commits.push(edit) });
      handles.attach({ actorId: "actor", componentId: "lake", kind: "lake", meshName: "actor:lake", properties: { width: 10, length: 6, assetGuid: "water" } });
      layer.utilityLayerScene.render();
      expect(handles.handleIds()).toContain("width+");
      const pick = layer.utilityLayerScene.getMeshByName("water-handle:width+")!;
      const drag = pick.getBehaviorByName("PointerDrag") as PointerDragBehavior;
      const event = (x: number) => ({ dragPlanePoint: new Vector3(x, 1, 0), pointerId: 1, pointerInfo: null, dragPlaneNormal: Vector3.Up(), dragDistance: 0, delta: Vector3.Zero() });
      drag.onDragStartObservable.notifyObservers(event(25) as never);
      drag.onDragObservable.notifyObservers(event(27) as never);
      expect(handles.isDragging()).toBe(true);
      expect(mesh.getBoundingInfo().boundingBox.maximum.x).toBeCloseTo(7);
      expect(commits).toEqual([]);
      drag.onDragEndObservable.notifyObservers(event(27) as never);
      expect(commits).toEqual([{ actorId: "actor", componentId: "lake", properties: { width: 14, length: 6, assetGuid: "water" } }]);
      handles.attach(null);
      expect(handles.handleIds()).toEqual([]);
      handles.dispose();
    } finally { vi.restoreAllMocks(); layer.dispose(); scene.dispose(); engine.dispose(); }
  });
});
