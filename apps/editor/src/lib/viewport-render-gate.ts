import { createAppSettingsStore } from "@babylonslate/vfs";

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
}): void {
  window.dispatchEvent(
    new CustomEvent(ENGINE_SETTINGS_CHANGED_EVENT, { detail: settings }),
  );
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

async function defaultLoadFrameCap(): Promise<number> {
  const settings = await createAppSettingsStore().load();
  return settings.viewportFrameCap;
}

export function attachViewportRenderGate(options: {
  canvas: HTMLCanvasElement;
  scheduler: ViewportRenderTarget;
  loadFrameCap?: () => Promise<number>;
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

  const applyCap = (fps: number) => {
    if (Number.isFinite(fps) && fps > 0) {
      scheduler.setFrameCap(fps);
    }
  };

  const onSettings = (event: Event) => {
    const detail = (event as CustomEvent<{ viewportFrameCap?: number }>).detail;
    if (detail && typeof detail.viewportFrameCap === "number") {
      applyCap(detail.viewportFrameCap);
    }
  };
  window.addEventListener(ENGINE_SETTINGS_CHANGED_EVENT, onSettings);

  void (options.loadFrameCap ?? defaultLoadFrameCap)().then(applyCap);

  return () => {
    intersection?.disconnect();
    mutation.disconnect();
    window.removeEventListener(ENGINE_SETTINGS_CHANGED_EVENT, onSettings);
  };
}
