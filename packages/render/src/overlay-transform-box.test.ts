import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MeshBuilder,
  PointerDragBehavior,
  Scene,
  UtilityLayerRenderer,
  Vector3,
  type AbstractMesh,
} from "@babylonjs/core";
import { createTestEngine } from "./create-null-engine";
import { createGizmoHost } from "./gizmo-host";
import {
  applyOverlayBoxDrag,
  createOverlayTransformBox,
  overlayBoxLocalBounds,
  OVERLAY_BOX_MIN_SCALE,
  type OverlayBoxDragStart,
  type OverlayBoxLocalBounds,
  type OverlayBoxTransform,
} from "./overlay-transform-box";

const UNIT: OverlayBoxLocalBounds = {
  minX: -0.5,
  maxX: 0.5,
  minY: -0.5,
  maxY: 0.5,
};

function start(
  gesture: OverlayBoxDragStart["gesture"],
  pointer: { x: number; y: number },
  transform: Partial<OverlayBoxTransform> = {},
  bounds: OverlayBoxLocalBounds = UNIT,
): OverlayBoxDragStart {
  return {
    gesture,
    bounds,
    pointer,
    transform: {
      position: [0, 0, 5],
      rotationZ: 0,
      scale: [1, 1, 1],
      ...transform,
    },
  };
}

describe("applyOverlayBoxDrag move", () => {
  it("adds the pointer delta to XY and leaves Z-order unchanged", () => {
    const next = applyOverlayBoxDrag(start("move", { x: 1, y: 2 }), {
      x: 3,
      y: 5,
    });
    expect(next.position[0]).toBeCloseTo(2);
    expect(next.position[1]).toBeCloseTo(3);
    expect(next.position[2]).toBe(5);
    expect(next.rotationZ).toBe(0);
    expect(next.scale).toEqual([1, 1, 1]);
  });

  it("snaps translated XY when snap is enabled", () => {
    const next = applyOverlayBoxDrag(
      start("move", { x: 0, y: 0 }),
      { x: 0.4, y: -0.7 },
      { enabled: true, translate: 0.5, rotateDeg: 15, scale: 0.25 },
    );
    expect(next.position[0]).toBeCloseTo(0.5);
    expect(next.position[1]).toBeCloseTo(-0.5);
    expect(next.position[2]).toBe(5);
  });
});

describe("applyOverlayBoxDrag resize", () => {
  it("keeps the west edge fixed when dragging east", () => {
    const next = applyOverlayBoxDrag(start("e", { x: 0.5, y: 0 }), {
      x: 1.5,
      y: 0.2,
    });
    expect(next.scale[0]).toBeCloseTo(2);
    expect(next.scale[1]).toBeCloseTo(1);
    expect(next.position[0]).toBeCloseTo(0.5);
    expect(next.position[1]).toBeCloseTo(0);
    expect(next.position[2]).toBe(5);
  });

  it("keeps the east edge fixed when dragging west", () => {
    const next = applyOverlayBoxDrag(start("w", { x: -0.5, y: 0 }), {
      x: -1.5,
      y: 0,
    });
    expect(next.scale[0]).toBeCloseTo(2);
    expect(next.position[0]).toBeCloseTo(-0.5);
    expect(next.position[1]).toBeCloseTo(0);
  });

  it("keeps the south edge fixed when dragging north", () => {
    const next = applyOverlayBoxDrag(start("n", { x: 0, y: 0.5 }), {
      x: 0,
      y: 1.5,
    });
    expect(next.scale[1]).toBeCloseTo(2);
    expect(next.position[1]).toBeCloseTo(0.5);
    expect(next.position[0]).toBeCloseTo(0);
  });

  it("keeps the north edge fixed when dragging south", () => {
    const next = applyOverlayBoxDrag(start("s", { x: 0, y: -0.5 }), {
      x: 0,
      y: -1.5,
    });
    expect(next.scale[1]).toBeCloseTo(2);
    expect(next.position[1]).toBeCloseTo(-0.5);
  });

  it("resizes both axes from a corner and keeps the opposite corner fixed", () => {
    const next = applyOverlayBoxDrag(start("se", { x: 0.5, y: -0.5 }), {
      x: 1.5,
      y: -1.5,
    });
    expect(next.scale[0]).toBeCloseTo(2);
    expect(next.scale[1]).toBeCloseTo(2);
    expect(next.position[0]).toBeCloseTo(0.5);
    expect(next.position[1]).toBeCloseTo(-0.5);
  });

  it("clamps scale to a positive minimum instead of flipping through zero", () => {
    const next = applyOverlayBoxDrag(start("e", { x: 0.5, y: 0 }), {
      x: -4,
      y: 0,
    });
    expect(next.scale[0]).toBeCloseTo(OVERLAY_BOX_MIN_SCALE);
    expect(next.scale[0]).toBeGreaterThan(0);
    expect(next.scale[1]).toBeCloseTo(1);
  });

  it("snaps resulting scale when snap is enabled", () => {
    const next = applyOverlayBoxDrag(
      start("e", { x: 0.5, y: 0 }),
      { x: 0.9, y: 0 },
      { enabled: true, translate: 1, rotateDeg: 15, scale: 0.5 },
    );
    expect(next.scale[0]).toBeCloseTo(1.5);
  });
});

describe("applyOverlayBoxDrag rotate", () => {
  it("applies Z rotation about the visual center from the pointer atan2 delta", () => {
    const next = applyOverlayBoxDrag(start("rotate", { x: 1, y: 0 }), {
      x: 0,
      y: 1,
    });
    expect(next.rotationZ).toBeCloseTo(Math.PI / 2);
    expect(next.position[0]).toBeCloseTo(0);
    expect(next.position[1]).toBeCloseTo(0);
    expect(next.position[2]).toBe(5);
    expect(next.scale).toEqual([1, 1, 1]);
  });

  it("orbits XY when the mesh origin is not the visual center", () => {
    const bounds: OverlayBoxLocalBounds = {
      minX: 0,
      maxX: 2,
      minY: -0.5,
      maxY: 0.5,
    };
    const next = applyOverlayBoxDrag(
      start("rotate", { x: 3, y: 0 }, {}, bounds),
      { x: 1, y: 2 },
    );
    expect(next.rotationZ).toBeCloseTo(Math.PI / 2);
    expect(next.position[0]).toBeCloseTo(1);
    expect(next.position[1]).toBeCloseTo(-1);
    expect(next.position[2]).toBe(5);
  });

  it("snaps rotation to rotateDeg steps", () => {
    const next = applyOverlayBoxDrag(
      start("rotate", { x: 1, y: 0 }),
      { x: Math.cos(0.2), y: Math.sin(0.2) },
      { enabled: true, translate: 1, rotateDeg: 15, scale: 0.25 },
    );
    expect(next.rotationZ).toBeCloseTo((15 * Math.PI) / 180);
  });
});

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
  vi.restoreAllMocks();
  while (handles.length > 0) {
    const handle = handles.pop();
    handle?.scene.dispose();
    handle?.engine.dispose();
  }
});

function dragOf(mesh: AbstractMesh | null): PointerDragBehavior {
  const behavior = mesh?.behaviors.find((entry) => entry.name === "PointerDrag");
  if (!behavior || !("onDragStartObservable" in behavior)) {
    throw new Error(`expected PointerDrag on ${mesh?.name ?? "missing mesh"}`);
  }
  return behavior as PointerDragBehavior;
}

function dragAt(x: number, y: number) {
  return {
    dragPlanePoint: new Vector3(x, y, 0),
    pointerId: 1,
    pointerInfo: null,
    delta: Vector3.Zero(),
    dragPlaneNormal: Vector3.Forward(),
    dragDistance: 0,
  };
}

describe("createOverlayTransformBox", () => {
  it("builds an interior, eight resize handles, and a rotation knob above the box", () => {
    const { scene } = createHandle();
    const layer = new UtilityLayerRenderer(scene);
    const mesh = MeshBuilder.CreatePlane("actor", { size: 1 }, scene);
    const box = createOverlayTransformBox(layer, scene);
    box.attachTo(mesh);
    const util = layer.utilityLayerScene;
    expect(util.getMeshByName("overlay-box-interior")).not.toBeNull();
    expect(util.getMeshByName("overlay-box-handle-e")).not.toBeNull();
    expect(util.getMeshByName("overlay-box-handle-se")).not.toBeNull();
    expect(util.getMeshByName("overlay-box-rotate")).not.toBeNull();
    const rotate = util.getMeshByName("overlay-box-rotate")!;
    const interior = util.getMeshByName("overlay-box-interior")!;
    rotate.computeWorldMatrix(true);
    interior.computeWorldMatrix(true);
    expect(rotate.getAbsolutePosition().y).toBeGreaterThan(
      interior.getAbsolutePosition().y + interior.getBoundingInfo().boundingBox.extendSizeWorld.y,
    );
    box.dispose();
    layer.dispose();
  });

  it("moves the attached mesh when the interior is dragged", () => {
    const { scene } = createHandle();
    const layer = new UtilityLayerRenderer(scene);
    const mesh = MeshBuilder.CreatePlane("actor", { size: 1 }, scene);
    const box = createOverlayTransformBox(layer, scene);
    box.attachTo(mesh);
    const interior = layer.utilityLayerScene.getMeshByName("overlay-box-interior");
    const drag = dragOf(interior);
    drag.onDragStartObservable.notifyObservers(dragAt(0, 0));
    drag.onDragObservable.notifyObservers(dragAt(2, 3));
    drag.onDragEndObservable.notifyObservers(dragAt(2, 3));
    expect(mesh.position.x).toBeCloseTo(2);
    expect(mesh.position.y).toBeCloseTo(3);
    expect(mesh.position.z).toBeCloseTo(0);
    expect(box.isDragging()).toBe(false);
    box.dispose();
    layer.dispose();
  });

  it("resizes with the east handle without moving Z", () => {
    const { scene } = createHandle();
    const layer = new UtilityLayerRenderer(scene);
    const mesh = MeshBuilder.CreatePlane("actor", { size: 1 }, scene);
    mesh.position.z = 4;
    const box = createOverlayTransformBox(layer, scene);
    box.attachTo(mesh);
    const handle = layer.utilityLayerScene.getMeshByName("overlay-box-handle-e");
    const drag = dragOf(handle);
    drag.onDragStartObservable.notifyObservers(dragAt(0.5, 0));
    drag.onDragObservable.notifyObservers(dragAt(1.5, 0));
    expect(mesh.scaling.x).toBeCloseTo(2);
    expect(mesh.position.x).toBeCloseTo(0.5);
    expect(mesh.position.z).toBeCloseTo(4);
    box.dispose();
    layer.dispose();
  });

  it("rotates around Z from the rotation knob", () => {
    const { scene } = createHandle();
    const layer = new UtilityLayerRenderer(scene);
    const mesh = MeshBuilder.CreatePlane("actor", { size: 1 }, scene);
    const box = createOverlayTransformBox(layer, scene);
    box.attachTo(mesh);
    const knob = layer.utilityLayerScene.getMeshByName("overlay-box-rotate");
    const drag = dragOf(knob);
    drag.onDragStartObservable.notifyObservers(dragAt(1, 0));
    drag.onDragObservable.notifyObservers(dragAt(0, 1));
    const euler = mesh.rotationQuaternion!.toEulerAngles();
    expect(euler.z).toBeCloseTo(Math.PI / 2);
    expect(mesh.position.x).toBeCloseTo(0);
    expect(mesh.position.y).toBeCloseTo(0);
    box.dispose();
    layer.dispose();
  });
});

describe("gizmo host overlay-box manipulator", () => {
  it("does not attach TRS gizmos and keeps the default host on axis gizmos", () => {
    const { scene } = createHandle();
    const mesh = MeshBuilder.CreatePlane("actor", { size: 1 }, scene);
    const overlay = createGizmoHost(scene, { manipulator: "overlay-box" });
    overlay.attachTo(mesh);
    expect(overlay.attachedMesh()).toBe(mesh);
    expect(overlay.positionGizmo.attachedMesh).toBeNull();
    expect(overlay.rotationGizmo.attachedMesh).toBeNull();
    expect(overlay.scaleGizmo.attachedMesh).toBeNull();
    overlay.dispose();

    const trs = createGizmoHost(scene, { tool: "translate" });
    trs.attachTo(mesh);
    expect(trs.positionGizmo.attachedMesh).toBe(mesh);
    trs.dispose();
  });

  it("hitTests true when the utility-layer pick hits the box", () => {
    const { scene } = createHandle();
    const mesh = MeshBuilder.CreatePlane("actor", { size: 1 }, scene);
    const overlay = createGizmoHost(scene, { manipulator: "overlay-box" });
    overlay.attachTo(mesh);
    vi.spyOn(Scene.prototype, "pick").mockReturnValue({ hit: true } as never);
    expect(overlay.hitTest(10, 10)).toBe(true);
    overlay.dispose();
  });

  it("moves, resizes, and Z-rotates through the host utility layer", () => {
    const { scene } = createHandle();
    const mesh = MeshBuilder.CreatePlane("actor", { size: 1 }, scene);
    const overlay = createGizmoHost(scene, { manipulator: "overlay-box" });
    overlay.attachTo(mesh);
    const util = overlay.positionGizmo.gizmoLayer.utilityLayerScene;

    const interior = util.getMeshByName("overlay-box-interior");
    const move = dragOf(interior);
    move.onDragStartObservable.notifyObservers(dragAt(0, 0));
    move.onDragObservable.notifyObservers(dragAt(2, 0));
    move.onDragEndObservable.notifyObservers(dragAt(2, 0));
    expect(mesh.position.x).toBeCloseTo(2);
    expect(mesh.scaling.x).toBeCloseTo(1);

    const handle = util.getMeshByName("overlay-box-handle-e");
    const resize = dragOf(handle);
    resize.onDragStartObservable.notifyObservers(dragAt(2.5, 0));
    resize.onDragObservable.notifyObservers(dragAt(3.5, 0));
    expect(mesh.scaling.x).toBeCloseTo(2);
    expect(mesh.position.x).toBeCloseTo(2.5);
    expect(mesh.position.z).toBeCloseTo(0);

    const knob = util.getMeshByName("overlay-box-rotate");
    const rotate = dragOf(knob);
    rotate.onDragStartObservable.notifyObservers(dragAt(3.5, 0));
    rotate.onDragObservable.notifyObservers(dragAt(2.5, 1));
    expect(mesh.rotationQuaternion!.toEulerAngles().z).not.toBe(0);
    overlay.dispose();
  });
});

describe("overlayBoxLocalBounds", () => {
  it("uses visual AABB and skips pick-proxy meshes", () => {
    const { scene } = createHandle();
    const origin = MeshBuilder.CreateBox("origin", { size: 10 }, scene);
    origin.metadata = { editorPickProxy: true };
    const visual = MeshBuilder.CreatePlane("visual", { size: 1 }, scene);
    visual.parent = origin;
    const bounds = overlayBoxLocalBounds(origin, [origin, visual]);
    expect(bounds.minX).toBeCloseTo(-0.5);
    expect(bounds.maxX).toBeCloseTo(0.5);
    expect(bounds.minY).toBeCloseTo(-0.5);
    expect(bounds.maxY).toBeCloseTo(0.5);
  });
});

