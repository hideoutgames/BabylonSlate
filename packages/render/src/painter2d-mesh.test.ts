import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DynamicTexture } from "@babylonjs/core";
import { parsePainter2DProperties } from "@haptic/core";
import { unlitBinding } from "./unlit-material-blocks";
import { createTestEngine } from "./test-support/test-engine";
import { createPainter2DMesh, updatePainter2DMesh } from "./painter2d-mesh";
import { applyAssignMesh, applyPainter2DCommand, applySnapshotToScene, createSnapshotSceneBinding } from "./snapshot-apply";

/** NullEngine runs in Node: DynamicTexture needs a canvas whose 2D calls are no-ops. */
function stubCanvasDocument(calls: string[]): () => void {
  const previous = (globalThis as { document?: unknown }).document;
  const context = new Proxy({}, { get: (_target, key) => key === "canvas" ? undefined : () => { calls.push(String(key)); } });
  (globalThis as { document: unknown }).document = {
    createElement: () => ({ width: 1, height: 1, getContext: () => context }),
  };
  return () => {
    if (previous === undefined) Reflect.deleteProperty(globalThis, "document");
    else (globalThis as { document: unknown }).document = previous;
  };
}

describe("Painter2D mesh", () => {
  const handles: ReturnType<typeof createTestEngine>[] = [];
  let restoreDocument: () => void;
  const canvasCalls: string[] = [];
  beforeEach(() => { canvasCalls.length = 0; restoreDocument = stubCanvasDocument(canvasCalls); });
  afterEach(() => {
    // Engine disposal unhooks document listeners, which the stub does not have.
    restoreDocument();
    for (const { scene, engine } of handles.splice(0)) { scene.dispose(); engine.dispose(); }
  });

  it("resizes the plane and canvas texture when an update changes the painter size", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const mesh = createPainter2DMesh(handle.scene, "painter", { width: 2, height: 1, pixelsPerUnit: 100 });
    const texture = unlitBinding(mesh).texture as DynamicTexture;
    const extent = () => {
      mesh.refreshBoundingInfo();
      const box = mesh.getBoundingInfo().boundingBox;
      return { width: box.extendSize.x * 2, height: box.extendSize.y * 2 };
    };
    expect(extent()).toEqual({ width: 2, height: 1 });
    expect(texture.getSize()).toMatchObject({ width: 200, height: 100 });

    expect(updatePainter2DMesh(mesh, { width: 4, height: 1.5, pixelsPerUnit: 100 })).toBe(true);
    expect(extent()).toEqual({ width: 4, height: 1.5 });
    expect(texture.getSize()).toMatchObject({ width: 400, height: 150 });

    updatePainter2DMesh(mesh, { width: 4, height: 1.5, pixelsPerUnit: 50 });
    expect(extent()).toEqual({ width: 4, height: 1.5 });
    expect(texture.getSize()).toMatchObject({ width: 200, height: 75 });
  });

  it("keeps a resized painter's bounds where its actor stands in Play", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const { scene } = handle;
    const binding = createSnapshotSceneBinding();
    const painter = (width: number, height: number) => parsePainter2DProperties({ width, height, pixelsPerUnit: 100 });
    applyAssignMesh(scene, binding, {
      type: "assignMesh", slotId: 3, meshAssetGuid: null, meshKind: "2dpainter", actorGuid: "bar",
      parts: [{
        componentId: "painter", meshKind: "2dpainter", meshAssetGuid: null, parentId: null,
        position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], painter: painter(2, 1),
      }],
    });
    applySnapshotToScene(scene, binding, {
      frameId: 1, tickIndex: 1, actorCount: 1,
      actors: [{ slotId: 3, flags: 1, position: { x: 5, y: 3, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } }],
    });
    const root = binding.meshes.get(3)!;
    // What a frame culls and a pointer picks the painter by.
    const bounds = () => {
      const box = root.getBoundingInfo().boundingBox;
      return [box.minimumWorld.asArray(), box.maximumWorld.asArray()];
    };
    expect(bounds()).toEqual([[4, 2.5, 0], [6, 3.5, 0]]);

    applyPainter2DCommand(binding, { type: "setPainter2D", slotId: 3, componentId: "painter", painter: painter(4, 1.5) });

    expect(binding.meshes.get(3)).toBe(root);
    expect(bounds()).toEqual([[3, 2.25, 0], [7, 3.75, 0]]);
  });

  it("replays the drawing only when the stream or the sizes it is drawn at change", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const circle = (radius: number) => ({ kind: "draw", fill: true, stroke: false,
      path: [{ kind: "ellipse", center: [0, 0], radius: [radius, radius], rotation: 0, start: 0, end: 6.28, anticlockwise: false }] });
    const painter = (radius: number, size: Record<string, number> = {}) => ({ width: 2, height: 1, pixelsPerUnit: 100, commands: [circle(radius)], ...size });
    const replays = () => canvasCalls.filter((call) => call === "clearRect").length;
    const mesh = createPainter2DMesh(handle.scene, "painter", painter(0.5));
    const initial = replays();
    expect(initial).toBeGreaterThan(0);

    // Equal content in fresh objects, as each command arrives.
    updatePainter2DMesh(mesh, painter(0.5));
    expect(replays()).toBe(initial);
    updatePainter2DMesh(mesh, painter(0.25));
    expect(replays()).toBe(initial + 1);
    updatePainter2DMesh(mesh, painter(0.25, { width: 4 }));
    expect(replays()).toBe(initial + 2);
    updatePainter2DMesh(mesh, painter(0.25, { width: 4, pixelsPerUnit: 50 }));
    expect(replays()).toBe(initial + 3);
    updatePainter2DMesh(mesh, painter(0.25, { width: 4, pixelsPerUnit: 50 }));
    expect(replays()).toBe(initial + 3);
  });

  it("takes the revision the runtime stamps as the stream shown, and replays when it or the sizes change", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const circle = (radius: number) => ({ kind: "draw", fill: true, stroke: false,
      path: [{ kind: "ellipse", center: [0, 0], radius: [radius, radius], rotation: 0, start: 0, end: 6.28, anticlockwise: false }] });
    const painter = (radius: number, revision?: number, size: Record<string, number> = {}) =>
      ({ width: 2, height: 1, pixelsPerUnit: 100, commands: [circle(radius)], ...(revision === undefined ? {} : { revision }), ...size });
    const replays = () => canvasCalls.filter((call) => call === "clearRect").length;
    const mesh = createPainter2DMesh(handle.scene, "painter", painter(0.5, 1));
    const initial = replays();

    // One revision names one stream, so its commands are trusted without being compared: a differing list stays unseen.
    updatePainter2DMesh(mesh, painter(0.25, 1));
    expect(replays()).toBe(initial);
    updatePainter2DMesh(mesh, painter(0.25, 2));
    expect(replays()).toBe(initial + 1);
    // A new revision for the stream already on the canvas (a painter redrawn each frame with the same shapes) is compared and not replayed.
    updatePainter2DMesh(mesh, painter(0.25, 3));
    expect(replays()).toBe(initial + 1);
    // An equal revision never skips a resize.
    updatePainter2DMesh(mesh, painter(0.25, 3, { pixelsPerUnit: 50 }));
    expect(replays()).toBe(initial + 2);
    // Authored data carries no revision, so it is compared with the canvas's stream.
    updatePainter2DMesh(mesh, painter(0.25, undefined, { pixelsPerUnit: 50 }));
    expect(replays()).toBe(initial + 2);
    updatePainter2DMesh(mesh, painter(0.5, undefined, { pixelsPerUnit: 50 }));
    expect(replays()).toBe(initial + 3);
  });
});
