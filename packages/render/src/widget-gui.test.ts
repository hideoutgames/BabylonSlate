import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Mesh, NullEngine, Scene } from "@babylonjs/core";
import {
  createDefaultUserInterface,
  createWidget,
  describeUiControls,
  pinLayout,
} from "@babylonslate/ui-runtime";
import { applyUiControls } from "./ui-apply";
import {
  attachMeshGui,
  createWidgetPlane,
  resolveWidgetBitmapSize,
  widgetPlaneWorldSize,
} from "./widget-gui";

function installOffscreenCanvasStub(): void {
  if (typeof globalThis.OffscreenCanvas !== "undefined") return;
  class OffscreenCanvasStub {
    width: number;
    height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }
    getContext(): CanvasRenderingContext2D {
      return {
        canvas: this,
        fillRect() {},
        clearRect() {},
        drawImage() {},
        getImageData() {
          return { data: new Uint8ClampedArray(4) };
        },
        putImageData() {},
        save() {},
        restore() {},
        scale() {},
        translate() {},
        fillText() {},
        measureText() {
          return { width: 0 };
        },
        beginPath() {},
        closePath() {},
        fill() {},
        stroke() {},
        rect() {},
        clip() {},
        setTransform() {},
        createLinearGradient() {
          return { addColorStop() {} };
        },
      } as unknown as CanvasRenderingContext2D;
    }
  }
  (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = OffscreenCanvasStub;
}

installOffscreenCanvasStub();

describe("createWidgetPlane", () => {
  let engine: NullEngine;
  let scene: Scene;

  beforeEach(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
  });

  afterEach(() => {
    try {
      scene.dispose();
    } catch {
      /* NullEngine ADT dispose can miss a canvas */
    }
    engine.dispose();
  });

  it("builds a front-only plane at the authored world size", () => {
    const mesh = createWidgetPlane(scene, "widget", {
      width: 2,
      height: 0.5,
      twoSided: false,
    });
    expect(mesh.getBoundingInfo().boundingBox.extendSize.x * 2).toBeCloseTo(2);
    expect(mesh.getBoundingInfo().boundingBox.extendSize.y * 2).toBeCloseTo(0.5);
    expect(mesh.sideOrientation).toBe(Mesh.FRONTSIDE);
  });

  it("uses double-sided orientation when twoSided is true", () => {
    const mesh = createWidgetPlane(scene, "widget-ds", { twoSided: true });
    expect(mesh.sideOrientation).toBe(Mesh.DOUBLESIDE);
  });
});

describe("widgetPlaneWorldSize", () => {
  it("keeps both axes when both are authored", () => {
    expect(widgetPlaneWorldSize({ width: 2, height: 1 }, { width: 400, height: 300 })).toEqual({
      width: 2,
      height: 1,
    });
  });

  it("derives the missing axis from the UI bitmap aspect", () => {
    expect(widgetPlaneWorldSize({ width: 2 }, { width: 400, height: 200 })).toEqual({
      width: 2,
      height: 1,
    });
    expect(widgetPlaneWorldSize({ height: 1 }, { width: 400, height: 200 })).toEqual({
      width: 2,
      height: 1,
    });
  });
});

describe("attachMeshGui", () => {
  let engine: NullEngine;
  let scene: Scene;

  beforeEach(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
  });

  afterEach(() => {
    try {
      scene.dispose();
    } catch {
      /* NullEngine ADT dispose can miss a canvas */
    }
    engine.dispose();
  });

  it("creates a mesh ADT, disables back-face culling when two-sided, and applies prefab controls", () => {
    const mesh = createWidgetPlane(scene, "panel", { twoSided: true });
    const doc = createDefaultUserInterface("Panel");
    doc.viewportLayer = false;
    const label = createWidget("title", "TextBlock", "Title");
    label.layout = pinLayout("center", "center", 80, 24);
    doc.widgets[label.id] = label;
    doc.widgets[doc.rootId]!.children = [label.id];
    const bitmap = resolveWidgetBitmapSize(doc);
    expect(bitmap).toEqual({ width: 400, height: 300 });
    const attached = attachMeshGui(mesh, {
      name: "widget-gui",
      twoSided: true,
      interactive: false,
      bitmap,
    });
    expect(mesh.material?.backFaceCulling).toBe(false);
    applyUiControls(
      attached.host,
      describeUiControls(doc, { parentSize: bitmap, applySafeArea: false }),
    );
    expect(attached.adt.getChildren().length).toBeGreaterThan(0);
    attached.dispose();
  });

  it("keeps front-face culling when twoSided is false", () => {
    const mesh = createWidgetPlane(scene, "front");
    const attached = attachMeshGui(mesh, {
      name: "front-gui",
      twoSided: false,
      interactive: true,
      bitmap: { width: 64, height: 64 },
    });
    expect(mesh.material?.backFaceCulling).toBe(true);
    attached.dispose();
  });
});
