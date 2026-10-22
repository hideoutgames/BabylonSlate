import { createElement } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "@haptic/ui/components/dialog";
import { RenderScheduler } from "@haptic/render/render-scheduler";
import {
  attachViewportRenderGate,
  applyLiveEngineSettings,
  canvasIsEditorVisible,
  dispatchEngineSettingsChanged,
  isBlockingEditorOverlayOpen,
  watchBlockingEditorOverlay,
} from "./viewport-render-gate";

describe("watchBlockingEditorOverlay", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  function overlayElement(): HTMLElement {
    const overlay = document.createElement("div");
    overlay.setAttribute("data-slot", "dialog-overlay");
    overlay.setAttribute("data-open", "");
    return overlay;
  }

  it("follows an overlay opening and closing", async () => {
    const watcher = watchBlockingEditorOverlay();
    try {
      expect(watcher.isOpen()).toBe(false);
      const overlay = overlayElement();
      document.body.append(overlay);
      await waitFor(() => expect(watcher.isOpen()).toBe(true));
      overlay.removeAttribute("data-open");
      overlay.setAttribute("data-closed", "");
      await waitFor(() => expect(watcher.isOpen()).toBe(false));
    } finally {
      watcher.dispose();
    }
  });

  it("starts from an overlay that is already open", () => {
    document.body.append(overlayElement());
    const watcher = watchBlockingEditorOverlay();
    try {
      expect(watcher.isOpen()).toBe(true);
    } finally {
      watcher.dispose();
    }
  });

  it("keeps tracking for the remaining watcher after another one is disposed", async () => {
    const first = watchBlockingEditorOverlay();
    const second = watchBlockingEditorOverlay();
    try {
      first.dispose();
      document.body.append(overlayElement());
      await waitFor(() => expect(second.isOpen()).toBe(true));
    } finally {
      first.dispose();
      second.dispose();
    }
  });
});

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

    const portal = document.createElement("div");
    const overlay = document.createElement("div");
    overlay.setAttribute("data-slot", "dialog-overlay");
    overlay.setAttribute("data-open", "");
    portal.append(overlay);
    document.body.append(portal);
    await Promise.resolve();

    expect(scheduler.shouldRender(50)).toBe(false);
    // Unrelated DOM churn keeps the freeze; the overlay's own changes lift and restore it.
    document.body.append(document.createElement("p"));
    await Promise.resolve();
    expect(scheduler.shouldRender(50)).toBe(false);
    overlay.setAttribute("data-closed", "");
    await Promise.resolve();
    expect(scheduler.shouldRender(50)).toBe(true);
    overlay.removeAttribute("data-closed");
    await Promise.resolve();
    expect(scheduler.shouldRender(50)).toBe(false);
    portal.remove();
    await Promise.resolve();
    expect(scheduler.shouldRender(50)).toBe(true);
    detach();
  });

  it("freezes while an editor Dialog is open", async () => {
    const canvas = document.createElement("canvas");
    Object.defineProperty(canvas, "clientWidth", { value: 200 });
    Object.defineProperty(canvas, "clientHeight", { value: 120 });
    document.body.append(canvas);
    const scheduler = new RenderScheduler();
    scheduler.setAlwaysRender(true);
    const detach = attachViewportRenderGate({ canvas, scheduler });
    const dialog = (open: boolean) =>
      createElement(Dialog, { open }, createElement(DialogContent, null, createElement(DialogTitle, null, "Project Settings")));

    // A modal Dialog marks everything outside its popup, its own backdrop
    // included, aria-hidden while it is open.
    const view = render(dialog(true));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(scheduler.shouldRender(0)).toBe(false);

    view.rerender(dialog(false));
    await waitFor(() => expect(scheduler.shouldRender(0)).toBe(true));
    view.unmount();
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

  it("forwards the post-processing gate when engine settings change", async () => {
    const canvas = document.createElement("canvas");
    Object.defineProperty(canvas, "clientWidth", { value: 200 });
    Object.defineProperty(canvas, "clientHeight", { value: 120 });
    document.body.append(canvas);

    const scheduler = new RenderScheduler();
    scheduler.setAlwaysRender(true);
    const setPostProcessingEnabled = vi.fn();
    const detach = attachViewportRenderGate({
      canvas,
      scheduler,
      loadFrameCap: async () => 60,
      setPostProcessingEnabled,
    });
    await Promise.resolve();
    dispatchEngineSettingsChanged({
      viewportFrameCap: 60,
      renderingOverridesEnabled: true,
      postProcessingEnabled: false,
    });
    expect(setPostProcessingEnabled).toHaveBeenCalledWith(false);
    detach();
  });
});

describe("applyLiveEngineSettings", () => {
  it("inherits project quality until local overrides are explicitly enabled, and restores inheritance", () => {
    const handle = { setLocalQualityOverrides: vi.fn(), scaling: { setLevel: vi.fn() }, setTextureBudget: vi.fn() };
    const settings = { hardwareScalingLevel: 2, textureByteCeiling: 1024 * 1024 * 1024 };
    applyLiveEngineSettings(handle, settings);
    expect(handle.setLocalQualityOverrides).toHaveBeenLastCalledWith({});
    expect(handle.scaling.setLevel).not.toHaveBeenCalled();
    expect(handle.setTextureBudget).not.toHaveBeenCalled();
    applyLiveEngineSettings(handle, { ...settings, renderingOverridesEnabled: true });
    expect(handle.setLocalQualityOverrides).toHaveBeenLastCalledWith({ resolution: { scale: 0.5, minScale: 0.5, dynamic: false }, textures: { byteBudget: 1024 * 1024 * 1024 } });
    applyLiveEngineSettings(handle, { ...settings, renderingOverridesEnabled: false });
    expect(handle.setLocalQualityOverrides).toHaveBeenLastCalledWith({});
  });
  it("applies hardware scaling and the post-processing gate without mutating a scene", () => {
    const scaling = { setLevel: vi.fn(), setSettingsLevel: vi.fn() };
    const handle = {
      scaling,
      scheduler: { setFrameCap: vi.fn() },
      setPostProcessingEnabled: vi.fn(),
    };
    applyLiveEngineSettings(handle, {
      viewportFrameCap: 30,
      renderingOverridesEnabled: true,
      hardwareScalingLevel: 1.5,
      postProcessingEnabled: false,
    });
    expect(handle.scheduler.setFrameCap).toHaveBeenCalledWith(30);
    expect(scaling.setSettingsLevel).toHaveBeenCalledWith(1.5);
    expect(scaling.setLevel).not.toHaveBeenCalled();
    expect(handle.setPostProcessingEnabled).toHaveBeenCalledWith(false);
  });

  it("does not apply viewportFrameCap onto a Play scheduler", () => {
    const scaling = { setLevel: vi.fn(), setSettingsLevel: vi.fn() };
    const handle = {
      scaling,
      scheduler: { setFrameCap: vi.fn() },
      setPostProcessingEnabled: vi.fn(),
    };
    applyLiveEngineSettings(
      handle,
      {
        viewportFrameCap: 30,
        renderingOverridesEnabled: true,
      hardwareScalingLevel: 1.5,
        postProcessingEnabled: false,
      },
      { applyFrameCap: false },
    );
    expect(handle.scheduler.setFrameCap).not.toHaveBeenCalled();
    expect(scaling.setSettingsLevel).toHaveBeenCalledWith(1.5);
    expect(handle.setPostProcessingEnabled).toHaveBeenCalledWith(false);
  });

  it("applies the texture memory budget without mutating a scene", () => {
    const handle = {
      setTextureBudget: vi.fn(),
    };
    applyLiveEngineSettings(handle, {
      renderingOverridesEnabled: true,
      textureBudgetEnabled: true,
      textureByteCeiling: 2 * 1024 * 1024 * 1024,
    });
    expect(handle.setTextureBudget).toHaveBeenCalledWith(
      2 * 1024 * 1024 * 1024,
      true,
    );
  });

  it("applies the audio PCM budget and voice cap without mutating a scene", () => {
    const handle = {
      setAudioBudget: vi.fn(),
      setMaxVoices: vi.fn(),
    };
    applyLiveEngineSettings(handle, {
      audioBudgetEnabled: true,
      audioByteCeiling: 256 * 1024 * 1024,
      audioMaxVoices: 48,
    });
    expect(handle.setAudioBudget).toHaveBeenCalledWith(256 * 1024 * 1024, true);
    expect(handle.setMaxVoices).toHaveBeenCalledWith(48);
  });
});
