import { afterEach, describe, expect, it } from "vitest";
import { NullEngine, Vector3, type PointerDragBehavior } from "@babylonjs/core";
import { createActor, createDefaultScene, createMeshComponent } from "@haptic/core";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { createEngine } from "./create-engine";

class FakeCanvas {
  width = 256;
  height = 256;
  clientWidth = 256;
  clientHeight = 256;
  addEventListener(): void {}
  removeEventListener(): void {}
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 256, height: 256 };
  }
}

const handles: Array<{ dispose: () => void }> = [];
const engines: NullEngine[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.dispose();
  while (engines.length > 0) engines.pop()?.dispose();
});

const box = (id: string, position: [number, number, number], scale: [number, number, number]) =>
  createActor(id, id, {
    transform: { position, rotation: [0, 0, 0, 1], scale },
    components: [createMeshComponent(`${id}-mesh`, "box")],
  });

/** Selects a (the gizmo's actor), b and c, links `linked`, and drags the X scale handle. */
function dragX(linked: readonly string[]) {
  const engine = adaptNullEngineFrameGraph(new NullEngine());
  engines.push(engine);
  const handle = createEngine(new FakeCanvas() as unknown as HTMLCanvasElement, {
    sharedEngine: engine,
    editor: true,
  });
  handles.push(handle);
  const editor = handle.editor!;
  handle.loadScene({
    ...createDefaultScene(),
    actors: [box("a", [0, 0, 0], [1, 2, 1]), box("b", [2, 0, 0], [1, 3, 1]), box("c", [-2, 0, 0], [1, 1, 4])],
  });
  editor.gizmos.setTool("scale");
  editor.setLinkedScaleActors(linked);
  editor.setSelectedActors(["a", "b", "c"]);
  expect(editor.gizmos.attachedMesh()).toBe(editor.sync.meshForActor("a"));
  const drag = editor.gizmos.scaleGizmo.xGizmo.dragBehavior;
  const at = { dragPlanePoint: Vector3.Zero(), pointerId: 1, pointerInfo: null };
  drag.onDragStartObservable.notifyObservers(at);
  for (const distance of [0.2, 0.3]) {
    drag.onDragObservable.notifyObservers({
      ...at,
      delta: new Vector3(distance, 0, 0),
      dragPlaneNormal: Vector3.Forward(),
      dragDistance: distance,
    });
  }
  drag.onDragEndObservable.notifyObservers(at);
  const mesh = (id: string) => editor.sync.meshForActor(id)!;
  return {
    factor: mesh("a").scaling.x,
    scale: (id: string) => mesh(id).scaling.asArray(),
    x: (id: string) => mesh(id).position.x,
  };
}

describe("scale gizmo with a partly linked selection", () => {
  it("rescales each linked actor by the dragged factor and leaves unlinked actors' other axes", () => {
    const { factor, scale, x } = dragX(["a", "b"]);
    expect(factor).toBeGreaterThan(1.05);
    expect(scale("a")).toEqual([factor, 2 * factor, factor].map((v) => expect.closeTo(v, 5)));
    expect(scale("b")).toEqual([factor, 3 * factor, factor].map((v) => expect.closeTo(v, 5)));
    expect(scale("c")).toEqual([factor, 1, 4].map((v) => expect.closeTo(v, 5)));
    // The group still spreads along the dragged axis only.
    expect(x("b")).toBeCloseTo(2 * factor, 5);
    expect(x("c")).toBeCloseTo(-2 * factor, 5);
  });

  it("follows an unlinked pivot with linked followers", () => {
    const { factor, scale } = dragX(["b"]);
    expect(scale("a")).toEqual([factor, 2, 1].map((v) => expect.closeTo(v, 5)));
    expect(scale("b")).toEqual([factor, 3 * factor, factor].map((v) => expect.closeTo(v, 5)));
    expect(scale("c")).toEqual([factor, 1, 4].map((v) => expect.closeTo(v, 5)));
  });

  it("scales the whole group proportionally when every actor is linked", () => {
    const { factor, scale } = dragX(["a", "b", "c"]);
    expect(scale("b")).toEqual([factor, 3 * factor, factor].map((v) => expect.closeTo(v, 5)));
    expect(scale("c")).toEqual([factor, factor, 4 * factor].map((v) => expect.closeTo(v, 5)));
  });
});

describe("2D transform box with a partly linked selection", () => {
  it("keeps the linked actor's proportions and changes only the dragged axis of the others", () => {
    const engine = adaptNullEngineFrameGraph(new NullEngine());
    engines.push(engine);
    const handle = createEngine(new FakeCanvas() as unknown as HTMLCanvasElement, {
      sharedEngine: engine,
      editor: true,
      viewportMode: "2d",
      overlayTransformBox: true,
    });
    handles.push(handle);
    const editor = handle.editor!;
    handle.loadScene({
      ...createDefaultScene(),
      viewportMode: "2d",
      actors: [box("a", [0, 0, 0], [1, 2, 1]), box("b", [2, 0, 0], [1, 2, 1])],
    });
    editor.setLinkedScaleActors(["a"]);
    editor.setSelectedActors(["a", "b"]);
    const east = editor.gizmos.layer.utilityLayerScene.getMeshByName("overlay-box-handle-e");
    const drag = east?.behaviors.find((entry) => entry.name === "PointerDrag") as PointerDragBehavior;
    const at = (x: number) => ({
      dragPlanePoint: new Vector3(x, 0, 0),
      pointerId: 1,
      pointerInfo: null,
      delta: Vector3.Zero(),
      dragPlaneNormal: Vector3.Forward(),
      dragDistance: 0,
    });
    // The box frames both boxes; drag its east edge one unit right.
    drag.onDragStartObservable.notifyObservers(at(2.5));
    drag.onDragObservable.notifyObservers(at(3.5));
    drag.onDragEndObservable.notifyObservers(at(3.5));
    const scale = (id: string) => editor.sync.meshForActor(id)!.scaling.asArray();
    const factor = scale("a")[0];
    expect(factor).toBeGreaterThan(1.05);
    expect(scale("a")).toEqual([factor, 2 * factor, 1].map((v) => expect.closeTo(v, 5)));
    expect(scale("b")).toEqual([factor, 2, 1].map((v) => expect.closeTo(v, 5)));
  });
});
