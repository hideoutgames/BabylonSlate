import type { Camera } from "@babylonjs/core/Cameras/camera";

/** Input over an editor view that must find it at its full frame cap (`RenderScheduler.noteActivity`). */
const VIEW_INPUT_EVENTS = [
  "pointerdown", "pointermove", "pointerup", "pointercancel", "wheel",
  "touchstart", "touchmove", "touchend", "keydown", "keyup",
] as const;
const WINDOW_KEY_EVENTS = ["keydown", "keyup"] as const;

/**
 * Calls `onActivity` for pointer, wheel, touch and keyboard input over `canvas`. Keys count while the pointer is over
 * the canvas or it has focus: viewport fly keys listen on the window.
 */
export function observeViewInput(canvas: HTMLElement, onActivity: () => void): () => void {
  let hovered = false;
  const onInput = () => onActivity();
  const onEnter = () => { hovered = true; onActivity(); };
  const onLeave = () => { hovered = false; };
  const onWindowKey = () => {
    if (hovered || canvas.ownerDocument.activeElement === canvas) onActivity();
  };
  const view = canvas.ownerDocument.defaultView;
  const options = { capture: true, passive: true } as const;
  for (const type of VIEW_INPUT_EVENTS) canvas.addEventListener(type, onInput, options);
  canvas.addEventListener("pointerenter", onEnter, options);
  canvas.addEventListener("pointerleave", onLeave, options);
  for (const type of WINDOW_KEY_EVENTS) view?.addEventListener(type, onWindowKey, options);
  return () => {
    for (const type of VIEW_INPUT_EVENTS) canvas.removeEventListener(type, onInput, options);
    canvas.removeEventListener("pointerenter", onEnter, options);
    canvas.removeEventListener("pointerleave", onLeave, options);
    for (const type of WINDOW_KEY_EVENTS) view?.removeEventListener(type, onWindowKey, options);
  };
}

/**
 * Whether the view's camera moved since the last call: another camera took the view, or its view matrix was
 * recomputed (fly, orbit, pan, inertia, focus tweens, a possessed or animated camera). Babylon recomputes the view
 * matrix only when the camera changed, so its `updateFlag` changes exactly then.
 */
export function createCameraMotionProbe(): (camera: Camera | null) => boolean {
  let lastCamera: Camera | null = null;
  let lastFlag = -1;
  return (camera) => {
    if (!camera) {
      const moved = lastCamera !== null;
      lastCamera = null;
      return moved;
    }
    const flag = camera.getViewMatrix().updateFlag;
    const moved = camera !== lastCamera || flag !== lastFlag;
    lastCamera = camera;
    lastFlag = flag;
    return moved;
  };
}
