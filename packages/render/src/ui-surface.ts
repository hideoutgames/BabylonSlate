import { Scene } from "@babylonjs/core/scene";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { PointerEventTypes, PointerInfoPre } from "@babylonjs/core/Events/pointerEvents";
import type { IMouseEvent } from "@babylonjs/core/Events/deviceInputEvents";
import type { Engine } from "@babylonjs/core/Engines/engine";
import { AdvancedDynamicTexture } from "@babylonjs/gui/2D/advancedDynamicTexture";
import type { ScaleRule } from "@babylonslate/ui-runtime";
import {
  applyAdtIdeal,
  BabylonUiApplyHost,
  createAdtControlFactory,
  paintDesignerGizmos,
  type BabylonUiHostOptions,
  type DesignerGizmoState,
} from "./babylon-ui-host";
import { uiHostStats } from "./ui-apply";

export interface UiSurfaceOptions extends BabylonUiHostOptions {
  name: string;
  designResolution: { width: number; height: number };
  scaleRule: ScaleRule;
  /** Screen-space overlay canvas (not CSS-transformed with the device frame). */
  gizmoCanvas?: HTMLCanvasElement;
  safeArea?: { left: number; right: number; top: number; bottom: number };
}

export interface UiSurface {
  scene: Scene;
  designAdt: AdvancedDynamicTexture;
  gizmoAdt: AdvancedDynamicTexture | null;
  host: BabylonUiApplyHost;
  present: () => void;
  presentGizmos: (state: DesignerGizmoState) => void;
  resizeDesign: (
    width: number,
    height: number,
    scaleRule: ScaleRule,
    designResolution?: { width: number; height: number },
  ) => void;
  resizeGizmos: (width: number, height: number) => void;
  /** Skip ADT blits (markDirty, pointers, present) while the dock tab is hidden. */
  setFrozen: (frozen: boolean) => void;
  dispose: () => void;
}

/** Skip ADT Canvas2D copies while a Dockview GUI tab is hidden. */
export function blitIfUnfrozen(frozen: boolean, blit: () => void): void {
  if (!frozen) blit();
}

/**
 * Dedicated Scene + standalone ADTs on the shared app Engine.
 *
 * Do **not** `registerView` the designer canvas: that 2D-blits the last 3D
 * framebuffer (editor / Play) onto the document tab. GUI is painted into the
 * ADT's Canvas2D texture and copied onto the designer canvases instead.
 * Play HUD still uses {@link attachFullscreenGui} as a Layer on the Play scene.
 *
 * Needs a real Engine canvas (OffscreenCanvas is missing under NullEngine).
 */
export function createUiSurface(
  canvas: HTMLCanvasElement,
  engine: Engine,
  options: UiSurfaceOptions,
): UiSurface {
  const scene = new Scene(engine);
  scene.skipPointerMovePicking = true;
  scene.autoClear = false;
  scene.clearColor = new Color4(0, 0, 0, 0);
  new FreeCamera(`${options.name}:camera`, new Vector3(0, 0, -1), scene);

  const designAdt = createStandaloneAdt(
    `${options.name}:design`,
    scene,
    options.designResolution.width,
    options.designResolution.height,
    options.interactive,
  );
  applyAdtIdeal(designAdt, options.designResolution, options.scaleRule);

  const gizmoCanvas = options.gizmoCanvas;
  const gizmoAdt = gizmoCanvas
    ? createStandaloneAdt(
        `${options.name}:gizmo`,
        scene,
        Math.max(1, gizmoCanvas.clientWidth || gizmoCanvas.width || 1),
        Math.max(1, gizmoCanvas.clientHeight || gizmoCanvas.height || 1),
      )
    : null;

  let frozen = false;
  let designResolution = options.designResolution;
  const blitDesign = () =>
    blitIfUnfrozen(frozen, () => presentAdtToCanvas(designAdt, canvas));
  const blitGizmos = () => {
    if (!gizmoAdt || !gizmoCanvas) return;
    blitIfUnfrozen(frozen, () => presentAdtToCanvas(gizmoAdt, gizmoCanvas));
  };

  const factory = createAdtControlFactory(designAdt, {
    resolveImageUrl: options.resolveImageUrl,
    onTouchAxis: options.onTouchAxis,
    safeArea: options.safeArea,
  });
  const host = new BabylonUiApplyHost(factory, {
    interactive: options.interactive,
    resolveImageUrl: options.resolveImageUrl,
    onTouchAxis: options.onTouchAxis,
    onWidgetEvent: options.onWidgetEvent,
    markDirty: () => {
      designAdt.markAsDirty();
      blitDesign();
    },
  });
  const detachPointers = options.interactive
    ? attachAdtCanvasPointers(canvas, designAdt, blitDesign, {
        onPickError: (error) => {
          console.error("ADT pick failed", error);
        },
      })
    : null;

  return {
    scene,
    designAdt,
    gizmoAdt,
    host,
    present: blitDesign,
    presentGizmos: (state) => {
      if (!gizmoAdt || !gizmoCanvas) return;
      paintDesignerGizmos(gizmoAdt, state);
      blitGizmos();
    },
    resizeDesign: (width, height, scaleRule, nextDesignResolution) => {
      if (nextDesignResolution) designResolution = nextDesignResolution;
      designAdt.scaleTo(Math.max(1, width), Math.max(1, height));
      applyAdtIdeal(designAdt, designResolution, scaleRule);
    },
    resizeGizmos: (width, height) => {
      gizmoAdt?.scaleTo(Math.max(1, width), Math.max(1, height));
    },
    setFrozen: (next) => {
      frozen = next;
    },
    dispose: () => {
      detachPointers?.();
      host.clear();
      gizmoAdt?.dispose();
      designAdt.dispose();
      scene.dispose();
    },
  };
}

/** Attach a Play HUD ADT to an existing Play scene (no extra Engine/Scene). */
export function attachFullscreenGui(
  scene: Scene,
  options: Omit<UiSurfaceOptions, "gizmoCanvas"> & {
    width: number;
    height: number;
  },
): { adt: AdvancedDynamicTexture; host: BabylonUiApplyHost; dispose: () => void } {
  const adt = AdvancedDynamicTexture.CreateFullscreenUI(options.name, true, scene);
  applyAdtIdeal(adt, options.designResolution, options.scaleRule);
  const factory = createAdtControlFactory(adt, {
    resolveImageUrl: options.resolveImageUrl,
    onTouchAxis: options.onTouchAxis,
    safeArea: options.safeArea,
  });
  const host = new BabylonUiApplyHost(factory, {
    interactive: options.interactive,
    resolveImageUrl: options.resolveImageUrl,
    onTouchAxis: options.onTouchAxis,
    onWidgetEvent: options.onWidgetEvent,
    markDirty: () => adt.markAsDirty(),
  });
  return {
    adt,
    host,
    dispose: () => {
      host.clear();
      adt.dispose();
    },
  };
}

function createStandaloneAdt(
  name: string,
  scene: Scene,
  width: number,
  height: number,
  interactive = false,
): AdvancedDynamicTexture {
  const adt = AdvancedDynamicTexture.CreateFullscreenUI(name, true, {
    scene,
    useStandalone: true,
    width: Math.max(1, width),
    height: Math.max(1, height),
  });
  adt.disablePicking = !interactive;
  adt.markAsDirty();
  adt._checkUpdate(null);
  return adt;
}

function pointerTypeFor(type: string): number {
  if (type === "pointerdown") return PointerEventTypes.POINTERDOWN;
  if (type === "pointerup" || type === "pointerleave" || type === "pointercancel") {
    return PointerEventTypes.POINTERUP;
  }
  if (type === "wheel") return PointerEventTypes.POINTERWHEEL;
  return PointerEventTypes.POINTERMOVE;
}

/** Forward 2D canvas pointers into a standalone ADT (no registerView). */
export function attachAdtCanvasPointers(
  canvas: HTMLCanvasElement,
  adt: AdvancedDynamicTexture,
  afterPick?: () => void,
  options?: { onPickError?: (error: unknown) => void },
): () => void {
  canvas.tabIndex = canvas.tabIndex >= 0 ? canvas.tabIndex : 0;
  let capturedId: number | null = null;

  const coords = (event: { clientX: number; clientY: number }) => {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    return {
      x: ((event.clientX - rect.left) / width) * canvas.width,
      y: ((event.clientY - rect.top) / height) * canvas.height,
    };
  };

  const pickAt = (event: Event, type: string) => {
    try {
      const pointer = event as PointerEvent;
      const { x, y } = coords(pointer);
      const info = new PointerInfoPre(
        pointerTypeFor(type),
        pointer as unknown as IMouseEvent,
        x,
        y,
      );
      adt.pick(x, y, info);
      afterPick?.();
    } catch (error) {
      options?.onPickError?.(error);
    }
  };

  const onPointer = (event: PointerEvent) => {
    event.stopPropagation?.();
    const isPrimary = event.isPrimary !== false;
    if (event.type === "pointerdown") {
      if (!isPrimary) return;
      try {
        canvas.setPointerCapture?.(event.pointerId);
      } catch {
        /* jsdom / already captured */
      }
      capturedId = event.pointerId;
      canvas.focus?.();
    } else if (capturedId != null) {
      if (event.pointerId !== capturedId) return;
    } else if (!isPrimary) {
      return;
    }
    if (
      event.type === "pointerup" ||
      event.type === "pointercancel" ||
      event.type === "pointerleave"
    ) {
      if (capturedId === event.pointerId) {
        try {
          canvas.releasePointerCapture?.(event.pointerId);
        } catch {
          /* jsdom */
        }
        capturedId = null;
      }
    }
    pickAt(event, event.type);
  };

  const onWheel = (event: WheelEvent) => {
    event.preventDefault?.();
    event.stopPropagation?.();
    pickAt(event, "wheel");
  };

  const onKey = (event: KeyboardEvent) => {
    try {
      const process = (
        adt as AdvancedDynamicTexture & {
          processKeyboard?: (evt: KeyboardEvent) => void;
        }
      ).processKeyboard;
      process?.call(adt, event);
      adt.focusedControl?.processKeyboard?.(event);
    } catch (error) {
      options?.onPickError?.(error);
    }
  };

  canvas.addEventListener("pointerdown", onPointer);
  canvas.addEventListener("pointermove", onPointer);
  canvas.addEventListener("pointerup", onPointer);
  canvas.addEventListener("pointerleave", onPointer);
  canvas.addEventListener("pointercancel", onPointer);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("keydown", onKey);
  canvas.addEventListener("keyup", onKey);
  return () => {
    canvas.removeEventListener("pointerdown", onPointer);
    canvas.removeEventListener("pointermove", onPointer);
    canvas.removeEventListener("pointerup", onPointer);
    canvas.removeEventListener("pointerleave", onPointer);
    canvas.removeEventListener("pointercancel", onPointer);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("keydown", onKey);
    canvas.removeEventListener("keyup", onKey);
  };
}

/** Paint the ADT's Canvas2D backing store onto a 2D designer canvas. */
export function presentAdtToCanvas(
  adt: AdvancedDynamicTexture,
  canvas: HTMLCanvasElement,
): void {
  adt._checkUpdate(null);
  let source = (adt.getContext() as CanvasRenderingContext2D | null)?.canvas;
  if (!source) {
    adt._checkUpdate(null);
    source = (adt.getContext() as CanvasRenderingContext2D | null)?.canvas;
  }
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Designer canvas has no 2d context for ADT blit");
  }
  if (!source) {
    throw new Error("ADT backing store is missing");
  }
  uiHostStats.present += 1;
  const size = adt.getSize();
  if (!(size.width > 0) || !(size.height > 0)) {
    return;
  }
  const width = size.width;
  const height = size.height;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  context.clearRect(0, 0, width, height);
  context.drawImage(source as CanvasImageSource, 0, 0);
}

/** Thrown present errors are hard only when the 2D blit cannot run. */
export function isHardUiPresentFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    /no 2d context/i.test(message) || /backing store is missing/i.test(message)
  );
}
