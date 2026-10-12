import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DynamicTexture, StandardMaterial } from "@babylonjs/core";
import { createTestEngine } from "./create-null-engine";
import { createPainter2DMesh, updatePainter2DMesh } from "./painter2d-mesh";

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
    const texture = (mesh.material as StandardMaterial).diffuseTexture as DynamicTexture;
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
});
