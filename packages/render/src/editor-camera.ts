import { ArcRotateCamera, Camera, Scene, Vector3 } from "@babylonjs/core";
import type { ViewportMode } from "@babylonslate/core";
import type { RenderScheduler } from "./render-scheduler";
import {
  pixelPerfectOrthoHalfHeight,
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

/** In-session 3D editor camera pose; plain numbers so it can leave Babylon. */
export interface EditorCameraPose3d {
  target: { x: number; y: number; z: number };
  alpha: number;
  beta: number;
  radius: number;
}

/** In-session 2D editor camera pose; plain numbers so it can leave Babylon. */
export interface EditorCameraPose2d {
  target: { x: number; y: number; z: number };
  orthoHalfHeight: number;
  pixelZoom: number;
}

/** Both mode slots, for restoring after a viewport remount. */
export interface EditorCameraSessionState {
  pose3d: EditorCameraPose3d | null;
  pose2d: EditorCameraPose2d | null;
}

function plainVec(v: Vector3): { x: number; y: number; z: number } {
  return { x: v.x, y: v.y, z: v.z };
}

export interface EditorCameraController {
  readonly camera: ArcRotateCamera;
  readonly mode: ViewportMode;
  /** Snapshot both mode poses so a remounted engine can restore them. */
  exportSessionState: () => EditorCameraSessionState;
  /** Restore exported poses; null/undefined is a no-op. */
  importSessionState: (state: EditorCameraSessionState | null | undefined) => void;
  setMode: (mode: ViewportMode) => void;
  /** Aspect-correct orthographic bounds; call on resize and on zoom. */
  updateOrthoBounds: (aspectRatio: number) => void;
  setOrthoHalfHeight: (halfHeight: number) => void;
  orthoHalfHeight: () => number;
  /** Pixel-perfect 2D framing; pass null to return to free ortho zoom. */
  setPixelPerfect: (settings: PixelPerfectSettings | null) => void;
  /** Canvas height in device pixels, needed to derive pixel-perfect bounds. */
  setCanvasHeight: (heightPx: number) => void;
  /** Zoom factor relative to the pixel-perfect 1:1 framing (continuous). */
  pixelZoom: () => number;
  /**
   * When true in 3D, `look` orbits around `camera.target` instead of looking
   * in place. No-op in 2D. Session-only; not stored on the scene document.
   */
  readonly pivotAroundCenter: boolean;
  setPivotAroundCenter: (enabled: boolean) => void;
  /**
   * Rotate look direction in place (camera position stays put) unless
   * `pivotAroundCenter` is on, in which case the eye orbits a fixed target.
   * No-op in 2D. `orbit` is an alias kept for existing call sites.
   */
  look: (deltaYaw: number, deltaPitch: number) => void;
  /** Same as `look`; kept so existing orbit call sites keep working. */
  orbit: (deltaAlpha: number, deltaBeta: number) => void;
  /**
   * Translate the camera along look (`forward`) and camera-right (`right`).
   * In 2D this is XY pan: forward → +Y, right → +X.
   */
  fly: (forward: number, right: number) => void;
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
  let pivotAroundCenter = false;
  let orthoHalfHeight = options.orthoHalfHeight ?? DEFAULT_CAMERA_RADIUS / 2;
  let aspect = 1;
  let pixelPerfect: PixelPerfectSettings | null = null;
  let canvasHeightPx = 0;
  /** Live pixel-perfect zoom; pinch and wheel stay continuous (not 1×/2× steps). */
  let pixelZoom = 1;
  let pose3d: {
    target: Vector3;
    alpha: number;
    beta: number;
    radius: number;
  } | null = null;
  let pose2d: {
    target: Vector3;
    orthoHalfHeight: number;
    pixelZoom: number;
  } | null = null;

  const invalidate = () => options.scheduler?.invalidate("camera");

  const applyPixelPerfectFraming = () => {
    if (!pixelPerfect || mode !== "2d" || canvasHeightPx <= 0) return;
    orthoHalfHeight = pixelPerfectOrthoHalfHeight(
      canvasHeightPx,
      pixelPerfect.pixelsPerUnit,
      pixelZoom,
    );
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

  const snapshotCurrent = () => {
    if (mode === "3d") {
      pose3d = {
        target: camera.target.clone(),
        alpha: camera.alpha,
        beta: camera.beta,
        radius: camera.radius,
      };
      return;
    }
    pose2d = {
      target: camera.target.clone(),
      orthoHalfHeight,
      pixelZoom,
    };
  };

  const restorePose = () => {
    if (mode === "3d") {
      if (!pose3d) return;
      camera.target.copyFrom(pose3d.target);
      camera.alpha = pose3d.alpha;
      camera.beta = pose3d.beta;
      camera.radius = pose3d.radius;
      return;
    }
    if (!pose2d) return;
    camera.target.copyFrom(pose2d.target);
    orthoHalfHeight = pose2d.orthoHalfHeight;
    pixelZoom = pose2d.pixelZoom;
    applyOrthoBounds();
  };

  applyMode();

  const look = (deltaYaw: number, deltaPitch: number) => {
    if (mode === "2d") return;
    camera.getViewMatrix();
    const position = camera.position.clone();
    camera.alpha += deltaYaw;
    camera.beta = Math.min(
      Math.PI - 0.01,
      Math.max(0.01, camera.beta + deltaPitch),
    );
    camera.getViewMatrix();
    if (!pivotAroundCenter) {
      camera.target.addInPlace(position.subtract(camera.position));
    }
    invalidate();
  };

  const fly = (forward: number, right: number) => {
    if (forward === 0 && right === 0) return;
    if (mode === "2d") {
      camera.target.x += right;
      camera.target.y += forward;
      invalidate();
      return;
    }
    camera.getViewMatrix();
    const lookDir = camera.getDirection(Vector3.Forward());
    const rightDir = camera.getDirection(Vector3.Right());
    camera.target.addInPlace(lookDir.scale(forward));
    camera.target.addInPlace(rightDir.scale(right));
    invalidate();
  };

  return {
    camera,
    get mode() {
      return mode;
    },
    get pivotAroundCenter() {
      return pivotAroundCenter;
    },
    setPivotAroundCenter: (enabled: boolean) => {
      pivotAroundCenter = enabled;
    },
    setMode: (next: ViewportMode) => {
      if (next === mode) return;
      snapshotCurrent();
      mode = next;
      applyMode();
      restorePose();
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
    look,
    orbit: look,
    fly,
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
      invalidate();
    },
    zoom: (factor: number) => {
      if (factor <= 0) return;
      if (mode === "2d") {
        if (pixelPerfect) {
          pixelZoom = Math.max(0.01, pixelZoom * factor);
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
      if (mode === "3d") {
        camera.getViewMatrix();
        camera.setTarget(target);
        camera.radius = Math.min(
          MAX_CAMERA_RADIUS,
          Math.max(MIN_CAMERA_RADIUS, camera.radius),
        );
      } else {
        camera.target.copyFrom(target);
      }
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
    exportSessionState: () => {
      snapshotCurrent();
      return {
        pose3d: pose3d
          ? {
              target: plainVec(pose3d.target),
              alpha: pose3d.alpha,
              beta: pose3d.beta,
              radius: pose3d.radius,
            }
          : null,
        pose2d: pose2d
          ? {
              target: plainVec(pose2d.target),
              orthoHalfHeight: pose2d.orthoHalfHeight,
              pixelZoom: pose2d.pixelZoom,
            }
          : null,
      };
    },
    importSessionState: (state) => {
      if (!state) return;
      pose3d = state.pose3d
        ? {
            target: new Vector3(
              state.pose3d.target.x,
              state.pose3d.target.y,
              state.pose3d.target.z,
            ),
            alpha: state.pose3d.alpha,
            beta: state.pose3d.beta,
            radius: state.pose3d.radius,
          }
        : null;
      pose2d = state.pose2d
        ? {
            target: new Vector3(
              state.pose2d.target.x,
              state.pose2d.target.y,
              state.pose2d.target.z,
            ),
            orthoHalfHeight: state.pose2d.orthoHalfHeight,
            pixelZoom: state.pose2d.pixelZoom,
          }
        : null;
      restorePose();
    },
    dispose: () => {
      camera.dispose();
    },
  };
}
