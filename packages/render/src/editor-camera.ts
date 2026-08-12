import { ArcRotateCamera, Camera, Scene, Vector3 } from "@babylonjs/core";
import type { ViewportMode } from "@babylonslate/core";
import type { RenderScheduler } from "./render-scheduler";
import {
  pixelPerfectOrthoHalfHeight,
  quantizeZoom,
  snapToPixelGrid,
  type PixelPerfectSettings,
} from "./pixel-perfect";

export const DEFAULT_CAMERA_RADIUS = 8;
export const MIN_CAMERA_RADIUS = 0.5;
export const MAX_CAMERA_RADIUS = 400;

/**
 * 2D convention (engineplan §13): the camera sits at negative Z looking toward
 * +Z on the XY plane, because Babylon is left-handed and the opposite
 * arrangement mirrors the scene. `scene.useRightHandedSystem` stays false.
 */
export const TWO_D_ALPHA = -Math.PI / 2;
export const TWO_D_BETA = Math.PI / 2;

export interface EditorCameraOptions {
  mode?: ViewportMode;
  scheduler?: Pick<RenderScheduler, "invalidate">;
  /** Half-height of the orthographic frustum in world units. */
  orthoHalfHeight?: number;
}

export interface EditorCameraController {
  readonly camera: ArcRotateCamera;
  readonly mode: ViewportMode;
  setMode: (mode: ViewportMode) => void;
  /** Aspect-correct orthographic bounds; call on resize and on zoom. */
  updateOrthoBounds: (aspectRatio: number) => void;
  setOrthoHalfHeight: (halfHeight: number) => void;
  orthoHalfHeight: () => number;
  /** Pixel-perfect 2D framing; pass null to return to free ortho zoom. */
  setPixelPerfect: (settings: PixelPerfectSettings | null) => void;
  /** Canvas height in device pixels, needed to derive pixel-perfect bounds. */
  setCanvasHeight: (heightPx: number) => void;
  /** Zoom factor relative to the pixel-perfect 1:1 framing. */
  pixelZoom: () => number;
  /** Orbit is a no-op in 2D, where the plan allows pan and zoom only. */
  orbit: (deltaAlpha: number, deltaBeta: number) => void;
  pan: (deltaX: number, deltaY: number) => void;
  zoom: (factor: number) => void;
  frame: (target: Vector3, radius?: number) => void;
  dispose: () => void;
}

/**
 * One camera controller parameterised by viewport mode rather than a
 * perspective-only controller with 2D bolted on later (engineplan §13.1).
 */
export function createEditorCamera(
  scene: Scene,
  options: EditorCameraOptions = {},
): EditorCameraController {
  const camera = new ArcRotateCamera(
    "editor-camera",
    -Math.PI / 2,
    Math.PI / 2.5,
    DEFAULT_CAMERA_RADIUS,
    Vector3.Zero(),
    scene,
  );
  camera.lowerRadiusLimit = MIN_CAMERA_RADIUS;
  camera.upperRadiusLimit = MAX_CAMERA_RADIUS;
  scene.activeCamera = camera;

  let mode: ViewportMode = options.mode ?? "3d";
  let orthoHalfHeight = options.orthoHalfHeight ?? DEFAULT_CAMERA_RADIUS / 2;
  let aspect = 1;
  let pixelPerfect: PixelPerfectSettings | null = null;
  let canvasHeightPx = 0;
  let pixelZoom = 1;

  const invalidate = () => options.scheduler?.invalidate("camera");

  const applyPixelPerfectFraming = () => {
    if (!pixelPerfect || mode !== "2d" || canvasHeightPx <= 0) return;
    orthoHalfHeight = pixelPerfectOrthoHalfHeight(
      canvasHeightPx,
      pixelPerfect.pixelsPerUnit,
      pixelZoom,
    );
    // A camera sitting between pixels smears every sprite, so the target is
    // pinned to the pixel grid whenever pixel-perfect framing is on.
    camera.target.x = snapToPixelGrid(camera.target.x, pixelPerfect.pixelsPerUnit);
    camera.target.y = snapToPixelGrid(camera.target.y, pixelPerfect.pixelsPerUnit);
  };

  const applyOrthoBounds = () => {
    applyPixelPerfectFraming();
    camera.orthoTop = orthoHalfHeight;
    camera.orthoBottom = -orthoHalfHeight;
    camera.orthoLeft = -orthoHalfHeight * aspect;
    camera.orthoRight = orthoHalfHeight * aspect;
  };

  const applyMode = () => {
    if (mode === "2d") {
      camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
      camera.alpha = TWO_D_ALPHA;
      camera.beta = TWO_D_BETA;
      // Orbiting an orthographic 2D scene is how you get lost, so pin it.
      camera.lowerAlphaLimit = TWO_D_ALPHA;
      camera.upperAlphaLimit = TWO_D_ALPHA;
      camera.lowerBetaLimit = TWO_D_BETA;
      camera.upperBetaLimit = TWO_D_BETA;
      applyOrthoBounds();
    } else {
      camera.mode = Camera.PERSPECTIVE_CAMERA;
      camera.lowerAlphaLimit = null;
      camera.upperAlphaLimit = null;
      camera.lowerBetaLimit = 0.01;
      camera.upperBetaLimit = Math.PI - 0.01;
    }
    invalidate();
  };

  applyMode();

  return {
    camera,
    get mode() {
      return mode;
    },
    setMode: (next: ViewportMode) => {
      if (next === mode) return;
      mode = next;
      applyMode();
    },
    updateOrthoBounds: (aspectRatio: number) => {
      aspect = aspectRatio > 0 ? aspectRatio : 1;
      if (mode === "2d") {
        applyOrthoBounds();
        invalidate();
      }
    },
    setOrthoHalfHeight: (halfHeight: number) => {
      orthoHalfHeight = Math.max(0.01, halfHeight);
      if (mode === "2d") {
        applyOrthoBounds();
        invalidate();
      }
    },
    orthoHalfHeight: () => orthoHalfHeight,
    orbit: (deltaAlpha: number, deltaBeta: number) => {
      if (mode === "2d") return;
      camera.alpha += deltaAlpha;
      camera.beta = Math.min(
        Math.PI - 0.01,
        Math.max(0.01, camera.beta + deltaBeta),
      );
      invalidate();
    },
    setPixelPerfect: (settings: PixelPerfectSettings | null) => {
      pixelPerfect = settings;
      if (mode === "2d") {
        applyOrthoBounds();
        invalidate();
      }
    },
    setCanvasHeight: (heightPx: number) => {
      canvasHeightPx = Math.max(0, heightPx);
      if (pixelPerfect && mode === "2d") {
        applyOrthoBounds();
        invalidate();
      }
    },
    pixelZoom: () => pixelZoom,
    pan: (deltaX: number, deltaY: number) => {
      const right = camera.getDirection(Vector3.Right());
      const up = camera.getDirection(Vector3.Up());
      camera.target.addInPlace(right.scaleInPlace(deltaX));
      camera.target.addInPlace(up.scaleInPlace(deltaY));
      if (pixelPerfect && mode === "2d") {
        camera.target.x = snapToPixelGrid(
          camera.target.x,
          pixelPerfect.pixelsPerUnit,
        );
        camera.target.y = snapToPixelGrid(
          camera.target.y,
          pixelPerfect.pixelsPerUnit,
        );
      }
      invalidate();
    },
    zoom: (factor: number) => {
      if (factor <= 0) return;
      if (mode === "2d") {
        if (pixelPerfect) {
          const next = pixelZoom * factor;
          pixelZoom = pixelPerfect.integerZoomSteps
            ? quantizeZoom(next)
            : Math.max(0.01, next);
        } else {
          orthoHalfHeight = Math.max(0.01, orthoHalfHeight / factor);
        }
        applyOrthoBounds();
      } else {
        camera.radius = Math.min(
          MAX_CAMERA_RADIUS,
          Math.max(MIN_CAMERA_RADIUS, camera.radius / factor),
        );
      }
      invalidate();
    },
    frame: (target: Vector3, radius?: number) => {
      camera.target.copyFrom(target);
      if (typeof radius === "number") {
        if (mode === "2d") {
          orthoHalfHeight = Math.max(0.01, radius);
          applyOrthoBounds();
        } else {
          camera.radius = Math.min(
            MAX_CAMERA_RADIUS,
            Math.max(MIN_CAMERA_RADIUS, radius),
          );
        }
      }
      invalidate();
    },
    dispose: () => {
      camera.dispose();
    },
  };
}
