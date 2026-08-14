import { Scene } from "@babylonjs/core/scene";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { PointerEventTypes, PointerInfoPre } from "@babylonjs/core/Events/pointerEvents";
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
  resizeDesign: (width: number, height: number, scaleRule: ScaleRule) => void;
  resizeGizmos: (width: number, height: number) => void;
  dispose: () => void;
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

  const factory = createAdtControlFactory(designAdt, {
    resolveImageUrl: options.resolveImageUrl,
    onTouchAxis: options.onTouchAxis,
    safeArea: options.safeArea,
  });
  const host = new BabylonUiApplyHost(factory, {
    interactive: options.interactive,
    resolveImageUrl: options.resolveImageUrl,
    onTouchAxis: options.onTouchAxis,
    markDirty: () => {
      designAdt.markAsDirty();
      presentAdtToCanvas(designAdt, canvas);
    },
  });
  const detachPointers = options.interactive
    ? attachAdtCanvasPointers(canvas, designAdt, () =>
        presentAdtToCanvas(designAdt, canvas),
      )
    : null;

  return {
    scene,
    designAdt,
    gizmoAdt,
    host,
    present: () => presentAdtToCanvas(designAdt, canvas),
    presentGizmos: (state) => {
      if (!gizmoAdt || !gizmoCanvas) return;
      paintDesignerGizmos(gizmoAdt, state);
      presentAdtToCanvas(gizmoAdt, gizmoCanvas);
    },
    resizeDesign: (width, height, scaleRule) => {
      designAdt.scaleTo(Math.max(1, width), Math.max(1, height));
      applyAdtIdeal(designAdt, options.designResolution, scaleRule);
    },
    resizeGizmos: (width, height) => {
      gizmoAdt?.scaleTo(Math.max(1, width), Math.max(1, height));
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
): () => void {
  const handle = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const x = ((event.clientX - rect.left) / width) * canvas.width;
    const y = ((event.clientY - rect.top) / height) * canvas.height;
    const info = new PointerInfoPre(pointerTypeFor(event.type), event, x, y);
    adt.pick(x, y, info);
    afterPick?.();
  };
  canvas.addEventListener("pointerdown", handle);
  canvas.addEventListener("pointermove", handle);
  canvas.addEventListener("pointerup", handle);
  canvas.addEventListener("pointerleave", handle);
  canvas.addEventListener("pointercancel", handle);
  return () => {
    canvas.removeEventListener("pointerdown", handle);
    canvas.removeEventListener("pointermove", handle);
    canvas.removeEventListener("pointerup", handle);
    canvas.removeEventListener("pointerleave", handle);
    canvas.removeEventListener("pointercancel", handle);
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
  const size = adt.getSize();
  const width = Math.max(1, size.width);
  const height = Math.max(1, size.height);
  if (!(size.width > 0) || !(size.height > 0)) {
    throw new Error("ADT blit size is 0");
  }
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  context.clearRect(0, 0, width, height);
  context.drawImage(source as CanvasImageSource, 0, 0);
}
