import { describe, expect, it } from "vitest";
import { CreateBox, FreeCamera, NullEngine, PointerDragBehavior, Scene, UtilityLayerRenderer, Vector3, type Mesh } from "@babylonjs/core";
import { createActor, createDefaultScene, parseDeformerProperties } from "@babylonslate/core";
import { createDeformerHandles, deformerHandleBody, deformerOutline } from "./deformer-handles";
import { selectedShapeComponent } from "./shape-edit-target";

const event = (point: Vector3) => ({ dragPlanePoint: point, pointerId: 1, pointerInfo: null, dragPlaneNormal: Vector3.Forward(), dragDistance: 0, delta: Vector3.Zero() });

function setup() {
  const engine = new NullEngine(), scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 10, -20), scene);
  camera.setTarget(Vector3.Zero());
  const layer = new UtilityLayerRenderer(scene), commits: { properties: Record<string, unknown> }[] = [];
  const handles = createDeformerHandles(layer, scene, { onCommit: (edit) => commits.push(edit) });
  const mesh = CreateBox("box", { width: 2, height: 4, depth: 6 }, scene);
  mesh.position.set(10, 0, 0);
  const attach = (properties: Record<string, unknown>, target: Mesh | null = mesh) => handles.attach({
    actorId: "actor", componentId: "cage", meshName: "box", properties, preview: false, resolveMesh: () => target,
  });
  const pick = (id: string) => layer.utilityLayerScene.getMeshByName(`deformer-handle:${id}`)!;
  const dispose = () => { handles.dispose(); layer.dispose(); scene.dispose(); engine.dispose(); };
  return { scene, layer, handles, mesh, attach, pick, commits, dispose };
}

describe("Deformer cage handles", () => {
  it("draws every cage edge through the offset controls", () => {
    const body = deformerHandleBody({ resolution: [3, 2, 2], offsets: [0, 1, 0] }, { min: [-1, -1, -1], max: [1, 1, 1] }, false);
    const lines = deformerOutline(body);
    // 2×2 rows along X, 2×3 along Y and 2×3 along Z.
    expect(lines).toHaveLength(16);
    expect(lines[0]).toEqual([[-1, 0, -1], [0, -1, -1], [1, -1, -1]]);
  });

  it("places controls on the fitted mesh bounds and commits a dragged offset once", () => {
    const { handles, attach, pick, commits, layer, dispose } = setup();
    try {
      attach(parseDeformerProperties({ targetMeshComponentId: "mesh", enabled: true }) as unknown as Record<string, unknown>);
      layer.utilityLayerScene.render();
      expect(handles.handleIds()).toHaveLength(8);
      const corner = pick("point:7");
      expect(corner.position.equalsWithEpsilon(new Vector3(11, 2, 3))).toBe(true);
      const drag = corner.getBehaviorByName("PointerDrag") as PointerDragBehavior;
      drag.onDragStartObservable.notifyObservers(event(corner.position.clone()) as never);
      drag.onDragObservable.notifyObservers(event(new Vector3(12, 2.5, 3)) as never);
      expect(commits).toEqual([]);
      drag.onDragEndObservable.notifyObservers(event(new Vector3(12, 2.5, 3)) as never);
      expect(commits).toHaveLength(1);
      const offsets = commits[0]!.properties.offsets as number[];
      expect(offsets.slice(21)).toEqual([1, 0.5, 0]);
      expect(offsets.slice(0, 21).every((value) => value === 0)).toBe(true);
      expect(commits[0]!.properties).not.toHaveProperty("cageMin");
      layer.utilityLayerScene.render();
      expect(handles.selectedNode()?.getAbsolutePosition().equalsWithEpsilon(new Vector3(12, 2.5, 3))).toBe(true);
    } finally { dispose(); }
  });

  it("uses authored bounds without Fit To Mesh and resets a point on double-click", () => {
    const { attach, pick, commits, layer, dispose } = setup();
    try {
      const offsets = Array.from({ length: 24 }, () => 0);
      offsets[0] = -1;
      attach({ enabled: true, fitToMesh: false, boundsMin: [0, 0, 0], boundsMax: [1, 1, 1], offsets });
      layer.utilityLayerScene.render();
      const first = pick("point:0");
      expect(first.position.equalsWithEpsilon(new Vector3(9, 0, 0))).toBe(true);
      const drag = first.getBehaviorByName("PointerDrag") as PointerDragBehavior;
      for (let tap = 0; tap < 2; tap++) {
        drag.onDragStartObservable.notifyObservers(event(first.position.clone()) as never);
        drag.onDragEndObservable.notifyObservers(event(first.position.clone()) as never);
      }
      expect(commits).toHaveLength(1);
      expect((commits[0]!.properties.offsets as number[]).every((value) => value === 0)).toBe(true);
    } finally { dispose(); }
  });

  it("shows nothing without a resolved target mesh", () => {
    const { handles, attach, layer, dispose } = setup();
    try {
      attach({ enabled: true }, null);
      layer.utilityLayerScene.render();
      expect(handles.handleIds()).toEqual([]);
    } finally { dispose(); }
  });

  it("is the shape edit target for a selected actor or component", () => {
    const actor = createActor("a", "Box", { components: [
      { id: "mesh", classId: "MeshComponent", properties: {} },
      { id: "cage", classId: "DeformerComponent", properties: { targetMeshComponentId: "mesh" } },
    ] });
    const scene = { ...createDefaultScene(), actors: [actor] };
    expect(selectedShapeComponent(scene, ["a"], [])?.component.id).toBe("cage");
    expect(selectedShapeComponent(scene, ["a"], ["cage"])?.component.id).toBe("cage");
    expect(selectedShapeComponent(scene, ["a"], ["mesh"])).toBeNull();
  });
});
