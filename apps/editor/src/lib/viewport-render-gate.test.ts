import { afterEach, describe, expect, it, vi } from "vitest";
import { RenderScheduler } from "@babylonslate/render";
import {
  attachViewportRenderGate,
  applyLiveEngineSettings,
  canvasIsEditorVisible,
  dispatchEngineSettingsChanged,
  isBlockingEditorOverlayOpen,
} from "./viewport-render-gate";

describe("isBlockingEditorOverlayOpen", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("is false when no overlay is present", () => {
    expect(isBlockingEditorOverlayOpen()).toBe(false);
  });

  it("is true for an open dialog overlay", () => {
    const overlay = document.createElement("div");
    overlay.setAttribute("data-slot", "dialog-overlay");
    overlay.setAttribute("data-open", "");
    document.body.append(overlay);
    expect(isBlockingEditorOverlayOpen()).toBe(true);
  });

  it("is true for an open alert-dialog overlay", () => {
    const overlay = document.createElement("div");
    overlay.setAttribute("data-slot", "alert-dialog-overlay");
    overlay.setAttribute("data-open", "");
    document.body.append(overlay);
    expect(isBlockingEditorOverlayOpen()).toBe(true);
  });

  it("is true for an open sheet overlay", () => {
    const overlay = document.createElement("div");
    overlay.setAttribute("data-slot", "sheet-overlay");
    overlay.setAttribute("data-open", "");
    document.body.append(overlay);
    expect(isBlockingEditorOverlayOpen()).toBe(true);
  });

  it("ignores dropdown menus", () => {
    const menu = document.createElement("div");
    menu.setAttribute("data-slot", "dropdown-menu-content");
    menu.setAttribute("data-open", "");
    document.body.append(menu);
    expect(isBlockingEditorOverlayOpen()).toBe(false);
  });

  it("ignores a closed overlay", () => {
    const overlay = document.createElement("div");
    overlay.setAttribute("data-slot", "dialog-overlay");
    overlay.setAttribute("data-closed", "");
    document.body.append(overlay);
    expect(isBlockingEditorOverlayOpen()).toBe(false);
  });
});

describe("canvasIsEditorVisible", () => {
  const onScreen = { left: 10, top: 10, right: 110, bottom: 90 };
  const viewport = { width: 800, height: 600 };

  it("requires a non-zero size", () => {
    expect(
      canvasIsEditorVisible({ clientWidth: 100, clientHeight: 80 }, true),
    ).toBe(true);
    expect(
      canvasIsEditorVisible({ clientWidth: 0, clientHeight: 80 }, true),
    ).toBe(false);
    expect(
      canvasIsEditorVisible({ clientWidth: 100, clientHeight: 0 }, true),
    ).toBe(false);
  });

  it("treats an on-screen rect as visible when IntersectionObserver reports false", () => {
    expect(
      canvasIsEditorVisible(
        { clientWidth: 100, clientHeight: 80 },
        false,
        onScreen,
        viewport,
      ),
    ).toBe(true);
  });

  it("stays hidden when the rect is fully off-screen", () => {
    expect(
      canvasIsEditorVisible(
        { clientWidth: 100, clientHeight: 80 },
        false,
        { left: -200, top: 0, right: -100, bottom: 80 },
        viewport,
      ),
    ).toBe(false);
  });

  it("stays hidden without a rect when IntersectionObserver reports false", () => {
    expect(
      canvasIsEditorVisible({ clientWidth: 100, clientHeight: 80 }, false),
    ).toBe(false);
  });
});

describe("attachViewportRenderGate", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("applies the loaded frame cap and freezes when a modal opens", async () => {
    const canvas = document.createElement("canvas");
    Object.defineProperty(canvas, "clientWidth", { value: 200 });
    Object.defineProperty(canvas, "clientHeight", { value: 120 });
    document.body.append(canvas);

    const scheduler = new RenderScheduler();
    scheduler.setAlwaysRender(true);
    const detach = attachViewportRenderGate({
      canvas,
      scheduler,
      loadFrameCap: async () => 30,
    });

    await Promise.resolve();
    expect(scheduler.shouldRender(0)).toBe(true);
    scheduler.noteRendered(0);
    expect(scheduler.shouldRender(20)).toBe(false);
    expect(scheduler.shouldRender(34)).toBe(true);

    const overlay = document.createElement("div");
    overlay.setAttribute("data-slot", "dialog-overlay");
    overlay.setAttribute("data-open", "");
    document.body.append(overlay);
    await Promise.resolve();

    expect(scheduler.shouldRender(50)).toBe(false);
    detach();
  });

  it("updates the frame cap when engine settings change", async () => {
    const canvas = document.createElement("canvas");
    Object.defineProperty(canvas, "clientWidth", { value: 200 });
    Object.defineProperty(canvas, "clientHeight", { value: 120 });
    document.body.append(canvas);

    const scheduler = new RenderScheduler();
    scheduler.setAlwaysRender(true);
    const detach = attachViewportRenderGate({
      canvas,
      scheduler,
      loadFrameCap: async () => 60,
    });
    await Promise.resolve();
    scheduler.noteRendered(0);
    expect(scheduler.shouldRender(17)).toBe(true);

    dispatchEngineSettingsChanged({ viewportFrameCap: 10 });
    expect(scheduler.shouldRender(50)).toBe(false);
    expect(scheduler.shouldRender(100)).toBe(true);
    detach();
  });
});

describe("applyLiveEngineSettings", () => {
  it("applies hardware scaling and the post-processing gate without mutating a scene", () => {
    const scaling = { setLevel: vi.fn() };
    const handle = {
      scaling,
      scheduler: { setFrameCap: vi.fn() },
      setPostProcessingEnabled: vi.fn(),
    };
    applyLiveEngineSettings(handle, {
      viewportFrameCap: 30,
      hardwareScalingLevel: 1.5,
      postProcessingEnabled: false,
    });
    expect(handle.scheduler.setFrameCap).toHaveBeenCalledWith(30);
    expect(scaling.setLevel).toHaveBeenCalledWith(1.5);
    expect(handle.setPostProcessingEnabled).toHaveBeenCalledWith(false);
  });
});
