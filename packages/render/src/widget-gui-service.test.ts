import { Mesh } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultUserInterface,
  createWidget,
  pinLayout,
} from "@babylonslate/ui-runtime";
import { createTestEngine } from "./create-null-engine";
import { WidgetGuiService } from "./widget-gui-service";
import { createWidgetVisualMesh } from "./widget-gui";

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
if (typeof globalThis.window === "undefined") {
  (globalThis as { window?: unknown }).window = {
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 800,
    innerHeight: 600,
    devicePixelRatio: 1,
  };
}

describe("WidgetGuiService", () => {
  const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
    [];

  afterEach(() => {
    while (handles.length > 0) {
      const handle = handles.pop();
      try {
        handle?.scene.dispose();
      } catch {
        /* NullEngine ADT dispose can miss a canvas */
      }
      try {
        handle?.engine.dispose();
      } catch {
        /* window stub + NullEngine ADT */
      }
    }
  });

  it("attaches CreateForMesh GUI on world uiApply and ignores HUD applies", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const mesh = createWidgetVisualMesh(
      handle.scene,
      "actor-0",
      {
        uiAssetGuid: "panel-ui",
        twoSided: true,
        width: 1,
        height: 1,
      },
      { width: 400, height: 300 },
    );
    const onWidgetEvent = vi.fn();
    const service = new WidgetGuiService({
      scene: handle.scene,
      onWidgetEvent,
    });
    const doc = createDefaultUserInterface("Panel");
    doc.viewportLayer = false;
    const label = createWidget("title", "TextBlock", "Title");
    label.layout = pinLayout("center", "center", 80, 24);
    doc.widgets[label.id] = label;
    doc.widgets[doc.rootId]!.children = [label.id];
    service.setLibrary(new Map([["panel-ui", doc]]));
    service.bindSlot(0, mesh);
    expect(
      service.handleCommand({
        type: "uiApply",
        instanceId: "ui-1",
        classId: "UserInterface:panel-ui",
        assetGuid: "panel-ui",
      }),
    ).toBe(false);
    expect(
      service.handleCommand({
        type: "uiApply",
        instanceId: "ui-1",
        classId: "UserInterface:panel-ui",
        assetGuid: "panel-ui",
        target: { kind: "world", slotId: 0, componentId: "widget-comp" },
      }),
    ).toBe(true);
    expect(mesh).toBeInstanceOf(Mesh);
    expect(mesh.material?.backFaceCulling).toBe(false);
    expect(
      service.handleCommand({
        type: "setInputMode",
        mode: "Game",
      }),
    ).toBe(true);
    expect(
      service.handleCommand({ type: "uiRemove", instanceId: "ui-1" }),
    ).toBe(true);
  });
});
