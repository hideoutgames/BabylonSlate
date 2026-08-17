import { createAppSettingsStore, type EngineSettings } from "@babylonslate/vfs";

export const ENGINE_SETTINGS_CHANGED_EVENT = "babylonslate:engine-settings";

export const BLOCKING_OVERLAY_SELECTOR = [
  '[data-slot="dialog-overlay"]',
  '[data-slot="alert-dialog-overlay"]',
  '[data-slot="sheet-overlay"]',
].join(",");

export type ViewportRenderTarget = {
  setVisible: (value: boolean) => void;
  setObstructed: (value: boolean) => void;
  setFrameCap: (fps: number) => void;
};

export function dispatchEngineSettingsChanged(settings: {
  viewportFrameCap: number;
  theme?: "system" | "light" | "dark";
  graphDefaultZoom?: number;
  uiDesignerPresets?: EngineSettings["uiDesignerPresets"];
  hardwareScalingLevel?: number;
  postProcessingEnabled?: boolean;
}): void {
  window.dispatchEvent(
    new CustomEvent(ENGINE_SETTINGS_CHANGED_EVENT, { detail: settings }),
  );
}

export type LiveEngineSettingsTarget = {
  scaling?: { setLevel: (level: number) => void };
  scheduler?: { setFrameCap: (fps: number) => void };
  setPostProcessingEnabled?: (enabled: boolean) => void;
};

export type LiveEngineSettings = {
  viewportFrameCap?: number;
  hardwareScalingLevel?: number;
  postProcessingEnabled?: boolean;
};

/** Apply local Engine Settings that must take effect without writing a scene. */
export function applyLiveEngineSettings(
  target: LiveEngineSettingsTarget,
  settings: LiveEngineSettings,
  options?: { applyFrameCap?: boolean },
): void {
  if (
    options?.applyFrameCap !== false &&
    typeof settings.viewportFrameCap === "number" &&
    Number.isFinite(settings.viewportFrameCap) &&
    settings.viewportFrameCap > 0
  ) {
    target.scheduler?.setFrameCap(settings.viewportFrameCap);
  }
  if (
    typeof settings.hardwareScalingLevel === "number" &&
    Number.isFinite(settings.hardwareScalingLevel) &&
    settings.hardwareScalingLevel > 0
  ) {
    target.scaling?.setLevel(settings.hardwareScalingLevel);
  }
  if (typeof settings.postProcessingEnabled === "boolean") {
    target.setPostProcessingEnabled?.(settings.postProcessingEnabled);
  }
}

export function isBlockingEditorOverlayOpen(
  root: ParentNode = document,
): boolean {
  const overlays = root.querySelectorAll(BLOCKING_OVERLAY_SELECTOR);
  for (let i = 0; i < overlays.length; i++) {
    const overlay = overlays[i];
    if (overlay && overlayIsOpen(overlay)) return true;
  }
  return false;
}

function overlayIsOpen(el: Element): boolean {
  if (el.hasAttribute("data-closed") || el.hasAttribute("hidden")) {
    return false;
  }
  if (el.getAttribute("aria-hidden") === "true") return false;
  return true;
}

export type EditorCanvasRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type EditorViewportSize = {
  width: number;
  height: number;
};

/** True when any pixel of the canvas rect overlaps the window. */
export function canvasRectIsOnScreen(
  rect: EditorCanvasRect,
  viewport: EditorViewportSize,
): boolean {
  return (
    rect.right > 0 &&
    rect.bottom > 0 &&
    rect.left < viewport.width &&
    rect.top < viewport.height
  );
}

export function canvasIsEditorVisible(
  canvas: Pick<HTMLElement, "clientWidth" | "clientHeight">,
  intersecting: boolean,
  rect?: EditorCanvasRect,
  viewport?: EditorViewportSize,
): boolean {
  if (canvas.clientWidth <= 0 || canvas.clientHeight <= 0) return false;
  if (intersecting) return true;
  if (!rect || !viewport) return false;
  return canvasRectIsOnScreen(rect, viewport);
}

export function attachViewportRenderGate(options: {
  canvas: HTMLCanvasElement;
  scheduler: ViewportRenderTarget;
  loadFrameCap?: () => Promise<number>;
  scaling?: { setLevel: (level: number) => void };
  setPostProcessingEnabled?: (enabled: boolean) => void;
}): () => void {
  const { canvas, scheduler } = options;

  const viewportSize = (): EditorViewportSize => ({
    width: window.innerWidth,
    height: window.innerHeight,
  });

  const applyObstructed = () => {
    scheduler.setObstructed(isBlockingEditorOverlayOpen());
  };
  const applyVisible = (
    intersecting: boolean,
    rect: EditorCanvasRect = canvas.getBoundingClientRect(),
  ) => {
    scheduler.setVisible(
      canvasIsEditorVisible(canvas, intersecting, rect, viewportSize()),
    );
  };

  applyObstructed();
  applyVisible(true);

  let intersection: IntersectionObserver | null = null;
  if (typeof IntersectionObserver !== "undefined") {
    intersection = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        applyVisible(entry.isIntersecting, entry.boundingClientRect);
      }
    });
    intersection.observe(canvas);
  }

  const mutation = new MutationObserver(() => applyObstructed());
  mutation.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-open", "data-closed", "hidden", "data-slot"],
  });

  const onSettings = (event: Event) => {
    const detail = (event as CustomEvent<LiveEngineSettings>).detail;
    if (!detail) return;
    applyLiveEngineSettings(
      {
        scheduler,
        scaling: options.scaling,
        setPostProcessingEnabled: options.setPostProcessingEnabled,
      },
      detail,
    );
  };
  window.addEventListener(ENGINE_SETTINGS_CHANGED_EVENT, onSettings);

  void (async () => {
    if (options.loadFrameCap) {
      applyLiveEngineSettings(
        { scheduler },
        { viewportFrameCap: await options.loadFrameCap() },
      );
      return;
    }
    const settings = await createAppSettingsStore().load();
    applyLiveEngineSettings(
      {
        scheduler,
        scaling: options.scaling,
        setPostProcessingEnabled: options.setPostProcessingEnabled,
      },
      {
        viewportFrameCap: settings.viewportFrameCap,
        hardwareScalingLevel: settings.hardwareScalingLevel,
        postProcessingEnabled: settings.postProcessingEnabled,
      },
    );
  })();

  return () => {
    intersection?.disconnect();
    mutation.disconnect();
    window.removeEventListener(ENGINE_SETTINGS_CHANGED_EVENT, onSettings);
  };
}
