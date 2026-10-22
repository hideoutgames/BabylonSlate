import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { ViewportMode } from "@haptic/core";

/** How long input must pause before a pilot gesture becomes one document edit. */
export const GAME_CAMERA_PILOT_COMMIT_DELAY_MS = 350;

/** World units a pinch or wheel zoom factor of e (2.718…) dollies the camera. */
const PILOT_DOLLY_PER_LOG = 4;

export interface GameCameraPilotTarget {
  actorId: string;
  /** The camera actor's root; piloting writes its local transform. */
  mesh: AbstractMesh;
  /** The previewed game camera, for its view axes. */
  camera: Camera;
}

export interface GameCameraPilotOptions {
  /** The camera actor to steer, or null when Game Camera is off or the actor cannot be edited. */
  target: () => GameCameraPilotTarget | null;
  /** In 2D, fly moves along the view plane and look and zoom do nothing. */
  mode?: () => ViewportMode;
  /** The mesh moved: re-sync cameras and redraw. */
  onMove: (target: GameCameraPilotTarget) => void;
  /** Input paused: write the actor's transform to the document as one edit. */
  onCommit: (target: GameCameraPilotTarget) => void;
  /** Before the first move of a gesture (unfreeze world matrices). */
  onBegin?: (target: GameCameraPilotTarget) => void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

/** The actor pose at pinch start, so pinch zoom is absolute like the editor camera's. */
export interface GameCameraPilotFraming {
  mesh: AbstractMesh;
  position: Vector3;
  rotation: Quaternion;
}

export interface GameCameraPilot {
  active: () => boolean;
  look: (deltaYaw: number, deltaPitch: number) => void;
  fly: (forward: number, right: number) => void;
  pan: (deltaX: number, deltaY: number) => void;
  zoom: (factor: number) => void;
  captureFraming: () => GameCameraPilotFraming | null;
  restoreFraming: (framing: GameCameraPilotFraming) => void;
  /** Commits a pending gesture now (Game Camera turned off). */
  flush: () => void;
  dispose: () => void;
}

const scratchInverse = new Matrix();
const scratchYaw = new Quaternion();
const scratchPitch = new Quaternion();

/**
 * Steers the scene's Default Camera actor while the viewport looks through it:
 * the editor's look, fly, pan and zoom inputs move the actor instead of the
 * editor camera, and each pause in input commits one undoable transform edit.
 */
export function createGameCameraPilot(options: GameCameraPilotOptions): GameCameraPilot {
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const mode = () => options.mode?.() ?? "3d";
  let pending: { target: GameCameraPilotTarget; timer: unknown } | null = null;

  const commit = () => {
    if (!pending) return;
    const { target, timer } = pending;
    clearTimer(timer);
    pending = null;
    options.onCommit(target);
  };

  const step = (move: (target: GameCameraPilotTarget) => void) => {
    const target = options.target();
    if (!target) return;
    if (pending && pending.target.mesh !== target.mesh) commit();
    if (!pending) options.onBegin?.(target);
    else clearTimer(pending.timer);
    move(target);
    options.onMove(target);
    pending = { target, timer: setTimer(commit, GAME_CAMERA_PILOT_COMMIT_DELAY_MS) };
  };

  /** Moves the actor by a world-space offset, honouring a parent transform. */
  const translateWorld = (mesh: AbstractMesh, offset: Vector3) => {
    const parent = mesh.parent;
    if (parent && "getWorldMatrix" in parent) {
      parent.getWorldMatrix().invertToRef(scratchInverse);
      Vector3.TransformNormalToRef(offset, scratchInverse, offset);
    }
    mesh.position.addInPlace(offset);
  };

  const along = (camera: Camera, axis: Vector3, distance: number) =>
    camera.getDirection(axis).scaleInPlace(distance);

  return {
    active: () => options.target() !== null,
    look: (deltaYaw, deltaPitch) => {
      if (mode() === "2d") return;
      step(({ mesh }) => {
        const rotation = (mesh.rotationQuaternion ??= Quaternion.FromEulerVector(mesh.rotation));
        // The editor camera turns right and down for negative deltas; a world-up
        // yaw keeps the horizon level and the pitch tilts about the actor's right.
        Quaternion.RotationAxisToRef(Vector3.Up(), -deltaYaw, scratchYaw);
        Quaternion.RotationAxisToRef(Vector3.Right(), -deltaPitch, scratchPitch);
        scratchYaw.multiplyToRef(rotation, rotation);
        rotation.multiplyInPlace(scratchPitch).normalize();
      });
    },
    fly: (forward, right) => {
      if (forward === 0 && right === 0) return;
      step(({ mesh, camera }) => {
        // In 2D the editor's fly is an XY pan, so forward follows the view's up.
        const ahead = mode() === "2d" ? Vector3.Up() : Vector3.Forward();
        translateWorld(mesh, along(camera, ahead, forward).addInPlace(along(camera, Vector3.Right(), right)));
      });
    },
    pan: (deltaX, deltaY) =>
      step(({ mesh, camera }) => {
        translateWorld(mesh, along(camera, Vector3.Right(), deltaX).addInPlace(along(camera, Vector3.Up(), deltaY)));
      }),
    zoom: (factor) => {
      // An orthographic game camera's size is a component setting, not its transform.
      if (!(factor > 0) || factor === 1 || mode() === "2d") return;
      step(({ mesh, camera }) => {
        translateWorld(mesh, along(camera, Vector3.Forward(), Math.log(factor) * PILOT_DOLLY_PER_LOG));
      });
    },
    captureFraming: () => {
      const target = options.target();
      if (!target) return null;
      const { mesh } = target;
      return {
        mesh,
        position: mesh.position.clone(),
        rotation: (mesh.rotationQuaternion ?? Quaternion.FromEulerVector(mesh.rotation)).clone(),
      };
    },
    restoreFraming: (framing) => {
      if (options.target()?.mesh !== framing.mesh) return;
      step(({ mesh }) => {
        mesh.position.copyFrom(framing.position);
        (mesh.rotationQuaternion ??= framing.rotation.clone()).copyFrom(framing.rotation);
      });
    },
    flush: commit,
    dispose: () => {
      if (pending) clearTimer(pending.timer);
      pending = null;
    },
  };
}
