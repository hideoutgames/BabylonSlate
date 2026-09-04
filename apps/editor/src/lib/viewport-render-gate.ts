import {
  createAppSettingsStore,
  ENGINE_SETTINGS_CHANGED_EVENT,
} from "@babylonslate/vfs";

export { ENGINE_SETTINGS_CHANGED_EVENT };

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
  hardwareScalingLevel?: number;
  postProcessingEnabled?: boolean;
  editorTextureLodEnabled?: boolean;
  editorTextureLodQuality?: number;
  textureBudgetEnabled?: boolean;
  textureByteCeiling?: number;
  audioBudgetEnabled?: boolean;
  audioByteCeiling?: number;
  audioMaxVoices?: number;
  viewportFlySpeed?: number;
  viewportGridSize?: number;
  modelImportDefaultScale?: number;
}): void {
  window.dispatchEvent(
    new CustomEvent(ENGINE_SETTINGS_CHANGED_EVENT, { detail: settings }),
  );
}

export type LiveEngineSettingsTarget = {
  scaling?: {
    setLevel: (level: number) => void;
    setSettingsLevel?: (level: number) => void;
  };
  scheduler?: { setFrameCap: (fps: number) => void };
  setPostProcessingEnabled?: (enabled: boolean) => void;
  setTextureBudget?: (bytes: number, enabled: boolean) => void;
  setAudioBudget?: (bytes: number, enabled: boolean) => void;
  setMaxVoices?: (maxVoices: number) => void;
};

export type LiveEngineSettings = {
  viewportFrameCap?: number;
  hardwareScalingLevel?: number;
  postProcessingEnabled?: boolean;
  editorTextureLodEnabled?: boolean;
  editorTextureLodQuality?: number;
  textureBudgetEnabled?: boolean;
  textureByteCeiling?: number;
  audioBudgetEnabled?: boolean;
  audioByteCeiling?: number;
  audioMaxVoices?: number;
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
    if (target.scaling?.setSettingsLevel) {
      target.scaling.setSettingsLevel(settings.hardwareScalingLevel);
    } else {
      target.scaling?.setLevel(settings.hardwareScalingLevel);
    }
  }
  if (typeof settings.postProcessingEnabled === "boolean") {
    target.setPostProcessingEnabled?.(settings.postProcessingEnabled);
  }
  if (
    typeof settings.textureByteCeiling === "number" ||
    typeof settings.textureBudgetEnabled === "boolean"
  ) {
    const bytes =
      typeof settings.textureByteCeiling === "number"
        ? settings.textureByteCeiling
        : 2 * 1024 * 1024 * 1024;
    const enabled =
      typeof settings.textureBudgetEnabled === "boolean"
        ? settings.textureBudgetEnabled
        : true;
    target.setTextureBudget?.(bytes, enabled);
  }
  if (
    typeof settings.audioByteCeiling === "number" ||
    typeof settings.audioBudgetEnabled === "boolean"
  ) {
    const bytes =
      typeof settings.audioByteCeiling === "number"
        ? settings.audioByteCeiling
        : 256 * 1024 * 1024;
    const enabled =
      typeof settings.audioBudgetEnabled === "boolean"
        ? settings.audioBudgetEnabled
        : true;
    target.setAudioBudget?.(bytes, enabled);
  }
  if (typeof settings.audioMaxVoices === "number") {
    target.setMaxVoices?.(settings.audioMaxVoices);
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
  scaling?: {
    setLevel: (level: number) => void;
    setSettingsLevel?: (level: number) => void;
  };
  setPostProcessingEnabled?: (enabled: boolean) => void;
  setTextureBudget?: (bytes: number, enabled: boolean) => void;
  setAudioBudget?: (bytes: number, enabled: boolean) => void;
  setMaxVoices?: (maxVoices: number) => void;
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
        setTextureBudget: options.setTextureBudget,
        setAudioBudget: options.setAudioBudget,
        setMaxVoices: options.setMaxVoices,
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
        setTextureBudget: options.setTextureBudget,
        setAudioBudget: options.setAudioBudget,
        setMaxVoices: options.setMaxVoices,
      },
      {
        viewportFrameCap: settings.viewportFrameCap,
        hardwareScalingLevel: settings.hardwareScalingLevel,
        postProcessingEnabled: settings.postProcessingEnabled,
        textureBudgetEnabled: settings.textureBudgetEnabled,
        textureByteCeiling: settings.textureByteCeiling,
        audioBudgetEnabled: settings.audioBudgetEnabled,
        audioByteCeiling: settings.audioByteCeiling,
        audioMaxVoices: settings.audioMaxVoices,
      },
    );
  })();

  return () => {
    intersection?.disconnect();
    mutation.disconnect();
    window.removeEventListener(ENGINE_SETTINGS_CHANGED_EVENT, onSettings);
  };
}
