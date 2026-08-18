import {
  Camera,
  Quaternion,
  UniversalCamera,
  Vector3,
  type Scene,
} from "@babylonjs/core";
import type { ViewportMode } from "@babylonslate/core";
import type { CommandMessage } from "@babylonslate/bridge";
import {
  attachViewportFlyKeys,
  DEFAULT_FLY_SPEED,
} from "./viewport-fly-keys";
import {
  PLAY_FREE_CAM_NAME,
  refreshPlayActiveCamera,
  type SnapshotSceneBinding,
} from "./snapshot-apply";

export { PLAY_FREE_CAM_NAME };

export type PlayFreeCamController = {
  enabled(): boolean;
  setEnabled(enabled: boolean): void;
  fly(forward: number, right: number): void;
  look(deltaYaw: number, deltaPitch: number): void;
  dispose(): void;
};

function copyPose(source: Camera, dest: UniversalCamera, mode: ViewportMode): void {
  dest.position.copyFrom(source.globalPosition);
  dest.minZ = source.minZ;
  dest.maxZ = source.maxZ;
  dest.fov = source.fov;
  if (mode === "2d") {
    dest.mode = Camera.ORTHOGRAPHIC_CAMERA;
    dest.orthoTop = source.orthoTop ?? 5;
    dest.orthoBottom = source.orthoBottom ?? -5;
    dest.orthoLeft = source.orthoLeft ?? -5 * (16 / 9);
    dest.orthoRight = source.orthoRight ?? 5 * (16 / 9);
    dest.rotationQuaternion = Quaternion.Identity();
    dest.setTarget(dest.position.add(new Vector3(0, 0, 1)));
    dest.rotation.set(0, 0, 0);
    return;
  }
  dest.mode = source.mode;
  const forward = source.getForwardRay().direction;
  dest.setTarget(dest.position.add(forward));
}

export function createPlayFreeCamController(
  scene: Scene,
  options: {
    binding: SnapshotSceneBinding;
    mode?: ViewportMode;
  },
): PlayFreeCamController {
  const mode = options.mode ?? "3d";
  let camera: UniversalCamera | null = null;
  let enabled = false;

  const detach = () => {
    if (!camera) {
      enabled = false;
      return;
    }
    if (scene.activeCamera === camera) {
      scene.activeCamera = null;
    }
    camera.dispose();
    camera = null;
    enabled = false;
    refreshPlayActiveCamera(scene, options.binding);
  };

  const attach = () => {
    if (enabled && camera) return;
    const source = scene.activeCamera;
    const next = new UniversalCamera(
      PLAY_FREE_CAM_NAME,
      source?.globalPosition.clone() ?? new Vector3(0, 0, -10),
      scene,
    );
    next.detachControl();
    next.inputs.clear();
    next.rotationQuaternion = Quaternion.Identity();
    if (source) copyPose(source, next, mode);
    camera = next;
    scene.activeCamera = next;
    enabled = true;
  };

  return {
    enabled: () => enabled,
    setEnabled(next) {
      if (next) attach();
      else detach();
    },
    fly(forward, right) {
      if (!camera || (forward === 0 && right === 0)) return;
      if (mode === "2d") {
        camera.position.x += right;
        camera.position.y += forward;
        return;
      }
      camera.computeWorldMatrix();
      const lookDir = camera.getDirection(Vector3.Forward());
      const rightDir = camera.getDirection(Vector3.Right());
      camera.position.addInPlace(lookDir.scale(forward));
      camera.position.addInPlace(rightDir.scale(right));
      camera.computeWorldMatrix();
    },
    look(deltaYaw, deltaPitch) {
      if (!camera || mode === "2d") return;
      if (!camera.rotationQuaternion) {
        camera.rotationQuaternion = Quaternion.Identity();
      }
      const yaw = Quaternion.FromEulerAngles(0, deltaYaw, 0);
      const pitch = Quaternion.FromEulerAngles(deltaPitch, 0, 0);
      camera.rotationQuaternion = yaw
        .multiply(camera.rotationQuaternion)
        .multiply(pitch);
      camera.rotation.set(0, 0, 0);
      camera.computeWorldMatrix();
    },
    dispose() {
      detach();
    },
  };
}

export function applyPlayFreeCamCommand(
  controller: PlayFreeCamController | null | undefined,
  command: CommandMessage,
): boolean {
  if (!controller) return false;
  if (command.type === "setFreeCam") {
    controller.setEnabled(command.enabled);
    return true;
  }
  if (command.type === "possessCamera") {
    controller.setEnabled(false);
    return false;
  }
  return false;
}

export function disablePlayFreeCam(
  controller: PlayFreeCamController | null | undefined,
): void {
  controller?.setEnabled(false);
}

export type PlayFreeCamInputHandle = {
  dispose: () => void;
};

export type PlayFreeCamInputOptions = {
  mode?: ViewportMode;
  keyTarget?: EventTarget;
  speed?: number;
  orbitScale?: number;
  panScale?: number;
  isEnabled?: () => boolean;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (id: number) => void;
};

/**
 * WASD flies (viewport fly math). Pointer drag looks in 3D and pans in 2D.
 * No-ops while the free camera is off.
 */
export function attachPlayFreeCamInput(
  canvas: HTMLCanvasElement,
  controller: PlayFreeCamController,
  options: PlayFreeCamInputOptions = {},
): PlayFreeCamInputHandle {
  const mode = options.mode ?? "3d";
  const orbitScale = options.orbitScale ?? 0.005;
  const panScale = options.panScale ?? 0.01;
  const enabled = () =>
    controller.enabled() && (options.isEnabled?.() ?? true);
  const keyTarget =
    options.keyTarget ??
    (typeof window !== "undefined" ? window : undefined);
  const flyKeys = keyTarget
    ? attachViewportFlyKeys(
        keyTarget,
        { fly: (forward, right) => controller.fly(forward, right) },
        canvas,
        {
          speed: options.speed,
          isEnabled: enabled,
          requestFrame: options.requestFrame,
          cancelFrame: options.cancelFrame,
        },
      )
    : null;

  const pointers = new Map<number, { x: number; y: number }>();

  const toCanvas = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect?.() ?? {
      left: 0,
      top: 0,
    };
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  };

  const onPointerDown = (event: PointerEvent) => {
    if (!enabled()) return;
    pointers.set(event.pointerId, toCanvas(event));
    canvas.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!enabled()) return;
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    const point = toCanvas(event);
    const dx = point.x - previous.x;
    const dy = point.y - previous.y;
    pointers.set(event.pointerId, point);
    if (dx === 0 && dy === 0) return;
    if (mode === "2d") {
      controller.fly(-dy * panScale, -dx * panScale);
      return;
    }
    controller.look(-dx * orbitScale, -dy * orbitScale);
  };

  const endPointer = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  return {
    dispose: () => {
      flyKeys?.dispose();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", endPointer);
      canvas.removeEventListener("pointercancel", endPointer);
      pointers.clear();
    },
  };
}

export { DEFAULT_FLY_SPEED };
