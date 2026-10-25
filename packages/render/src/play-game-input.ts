import type { Scene } from "@babylonjs/core";
import { sceneLayerCanvasToLayer } from "@haptic/core";
import type { CreateEngineOptions } from "./create-engine-types";
import type { Joystick2DInput } from "./joystick2d-input";
import type { OverlayLayoutRenderer } from "./overlay-layout-render";
import { mapCanvasPointer } from "./pick-coords";
import type { attachPlayCursor } from "./play-cursor";
import type { SceneLayerCompositor } from "./scene-layer-compositor";
import { applyOverlayPointer, type OverlayPointerPhase, type OverlayPointerState } from "./scene-layer-pointer";
import type { UIControls2DInput } from "./ui-controls2d-input";

/** What Play's game input reads from the Engine handle being built. */
export interface PlayGameInputContext {
  canvas: HTMLCanvasElement;
  scene: Scene;
  options: CreateEngineOptions;
  pointerCanvas: () => { width: number; height: number };
  sceneLayerCompositor: SceneLayerCompositor | null;
  layerLoads: ReadonlyMap<string, { loadId: number; ready: boolean }>;
  overlayLayouts: OverlayLayoutRenderer;
  /** False while the handle is paused, disposed or editing a Simulation. */
  acceptsGameInput: () => boolean;
  joysticks: Joystick2DInput;
  uiControls: UIControls2DInput;
  playCursor: ReturnType<typeof attachPlayCursor> | null;
  dispatchOverlayPointer: (phase: OverlayPointerPhase, canvasX: number, canvasY: number, pointerId?: number) => boolean;
  overlayPointerState: OverlayPointerState;
  onRollback: (cleanup: () => void) => void;
}

/**
 * Play's canvas input for SceneLayer UI: pointers, touch, wheel and drag
 * scrolling, on-screen joysticks and UI controls, and control keys. Attaches
 * its listeners on a game view (not an editor view) and detaches them on
 * rollback; the handle's dispose calls `detach`.
 */
export function createPlayGameInput({
  canvas,
  scene,
  options,
  pointerCanvas,
  sceneLayerCompositor,
  layerLoads,
  overlayLayouts,
  acceptsGameInput,
  joysticks,
  uiControls,
  playCursor,
  dispatchOverlayPointer,
  overlayPointerState,
  onRollback,
}: PlayGameInputContext): {
  /** A pointer a joystick, UI control or scroll drag holds, which the game must not also read. */
  ownsGamePointer: (pointerId: number) => boolean;
  /** Releases every held pointer, joystick, control and key. */
  resetJoysticks: () => void;
  detach: () => void;
} {

  // Tap-to-pick: continuous hover picking is off for touch.
  const overlayPointerCanvasCoords = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  };
  const scrollTargetAt = (x: number, y: number) => {
    const size = pointerCanvas();
    const mapped = mapCanvasPointer(scene, x, y, size);
    const blockingLayer = sceneLayerCompositor?.pickHits(mapped.x, mapped.y).find(hit => hit.hitTest === "block")?.layerId;
    for (const layer of [...(sceneLayerCompositor?.sortedLayers() ?? [])].reverse()) {
      if (layerLoads.get(layer.layerId)?.ready === false) continue;
      const point = sceneLayerCanvasToLayer(x, y, size.width, size.height, layer.viewBounds, layer.cameraState);
      const target = overlayLayouts.scrollAt(layer.layerId, point.x, point.y);
      // Wheel steps: layer units per screen pixel at the camera's zoom, along the box's own axes.
      const zoom = layer.cameraState.zoom;
      if (target?.componentId) return { target, layer, scaleX: layer.viewBounds.width / Math.max(1, size.width) / zoom / (target.scroll?.scaleX || 1), scaleY: layer.viewBounds.height / Math.max(1, size.height) / zoom / (target.scroll?.scaleY || 1) };
      if (layer.layerId === blockingLayer) break;
    }
    return undefined;
  };
  let scrollDrag: { pointerId: number; startX: number; startY: number; x: number; y: number; active: boolean; target: NonNullable<ReturnType<typeof scrollTargetAt>> } | null = null;
  const activeGamePointers = new Set<number>();
  const activeControlKeys = new Set<string>();
  const ownsGamePointer = (pointerId: number) =>
    joysticks.owns(pointerId) || uiControls.owns(pointerId) || (scrollDrag?.pointerId === pointerId && scrollDrag.active);
  const onOverlayWheel = (event: WheelEvent) => {
    if (!acceptsGameInput()) return;
    const rect = canvas.getBoundingClientRect();
    const hit = scrollTargetAt(event.clientX - rect.left, event.clientY - rect.top);
    if (!hit) return;
    event.preventDefault();
    const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
    // A horizontal box or Shift+wheel scrolls sideways by the dominant axis: a
    // native horizontal swipe keeps deltaX, and a vertical wheel with a little
    // horizontal jitter still scrolls by deltaY.
    const sideways = event.shiftKey || hit.target.scroll?.axis === "horizontal";
    const deltaX = sideways && Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    options.onSceneLayerScroll?.({ layerId: hit.layer.layerId, actorId: hit.target.actorId, componentId: hit.target.componentId!, deltaX: deltaX * factor * hit.scaleX, deltaY: event.shiftKey ? 0 : event.deltaY * factor * hit.scaleY });
  };
  const onPointerDown = (event: PointerEvent) => {
    if (!acceptsGameInput()) return;
    activeGamePointers.add(event.pointerId);
    event.preventDefault();
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture?.(event.pointerId);
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    playCursor?.notePointer(event.pointerType ?? "mouse", x, y);
    // Game views keep no world selection; a ray pick here changed nothing.
    dispatchOverlayPointer("down", x, y, event.pointerId);
    if (joysticks.owns(event.pointerId)) return;
    const controlOwns = uiControls.owns(event.pointerId);
    if (controlOwns && !uiControls.allowsScroll(event.pointerId)) return;
    const scrollTarget = event.pointerType === "touch" || event.pointerType === "pen" ? scrollTargetAt(x, y) : undefined;
    if (scrollTarget) scrollDrag = { pointerId: event.pointerId, startX: x, startY: y, x, y, active: false, target: scrollTarget };
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!acceptsGameInput() || ((event.pointerType === "touch" || event.buttons > 0) && !activeGamePointers.has(event.pointerId))) return;
    const { x, y } = overlayPointerCanvasCoords(event);
    if (joysticks.move(event.pointerId, x, y)) return;
    if (scrollDrag?.pointerId === event.pointerId) {
      if (!scrollDrag.active && Math.hypot(x - scrollDrag.startX, y - scrollDrag.startY) >= 8) {
        uiControls.cancelForScroll(event.pointerId);
        scrollDrag.active = true;
        for (const hit of overlayPointerState.pressed.values()) options.onSceneLayerPointer?.({ layerId: hit.layerId, actorGuid: hit.actorGuid, componentId: hit.componentId, event: "onPressEnd" });
        overlayPointerState.pressed.clear();
      }
      if (scrollDrag.active) {
        const { target, layer } = scrollDrag.target;
        // The drag in layer units through the layer camera, so it follows a moved, turned or zoomed view.
        const size = pointerCanvas();
        const from = sceneLayerCanvasToLayer(scrollDrag.x, scrollDrag.y, size.width, size.height, layer.viewBounds, layer.cameraState);
        const to = sceneLayerCanvasToLayer(x, y, size.width, size.height, layer.viewBounds, layer.cameraState);
        options.onSceneLayerScroll?.({ layerId: layer.layerId, actorId: target.actorId, componentId: target.componentId!,
          deltaX: (from.x - to.x) / (target.scroll?.scaleX || 1), deltaY: (to.y - from.y) / (target.scroll?.scaleY || 1) });
        scrollDrag.x = x; scrollDrag.y = y;
        return;
      }
    }
    if (uiControls.move(event.pointerId, x, y)) return;
    playCursor?.notePointer(event.pointerType ?? "mouse", x, y);
    dispatchOverlayPointer("move", x, y);
  };
  const onPointerUp = (event: PointerEvent) => {
    if (!activeGamePointers.delete(event.pointerId) || !acceptsGameInput()) return;
    const point = overlayPointerCanvasCoords(event);
    const wasScrolling = scrollDrag?.pointerId === event.pointerId && scrollDrag.active;
    if (scrollDrag?.pointerId === event.pointerId) scrollDrag = null;
    if (wasScrolling) return;
    if (uiControls.release(event.pointerId, false, point.x, point.y) || joysticks.release(event.pointerId)) return;
    const { x, y } = overlayPointerCanvasCoords(event);
    playCursor?.notePointer(event.pointerType ?? "mouse", x, y);
    dispatchOverlayPointer("up", x, y);
  };
  const onPointerCancel = (event: PointerEvent) => {
    if (!activeGamePointers.delete(event.pointerId) || !acceptsGameInput()) return;
    if (scrollDrag?.pointerId === event.pointerId) scrollDrag = null;
    if (uiControls.release(event.pointerId, true) || joysticks.release(event.pointerId)) return;
    const { x, y } = overlayPointerCanvasCoords(event);
    playCursor?.notePointer(event.pointerType ?? "mouse", x, y);
    dispatchOverlayPointer("cancel", x, y);
  };
  // A lifted or cancelled touch, and a mouse leaving the canvas, both end in
  // pointerleave: nothing stays hovered, while up/cancel keep a mouse's hover.
  const onPointerLeave = () => {
    if (!acceptsGameInput()) return;
    for (const event of applyOverlayPointer(overlayPointerState, "move", [])) options.onSceneLayerPointer?.(event);
  };
  const resetJoysticks = () => {
    scrollDrag = null;
    joysticks.reset();
    uiControls.reset();
    for (const event of [...applyOverlayPointer(overlayPointerState, "cancel", []), ...applyOverlayPointer(overlayPointerState, "move", [])])
      options.onSceneLayerPointer?.(event);
    const captured = [...activeGamePointers];
    activeGamePointers.clear();
    activeControlKeys.clear();
    const document = canvas.ownerDocument;
    if (document?.pointerLockElement === canvas) document.exitPointerLock?.();
    for (const pointerId of captured) {
      try { canvas.releasePointerCapture?.(pointerId); } catch { /* Capture may already have ended. */ }
    }
  };
  const onCanvasBlur = (event: FocusEvent) => { if (!uiControls.ownsElement(event.relatedTarget)) resetJoysticks(); };
  const onControlKeyDown = (event: KeyboardEvent) => {
    const key = event.code || event.key;
    if (!acceptsGameInput() || (event.repeat && !activeControlKeys.has(key))) return;
    activeControlKeys.add(key);
    uiControls.keyDown(event);
  };
  const onControlKeyUp = (event: KeyboardEvent) => { activeControlKeys.delete(event.code || event.key); };
  const onJoystickVisibility = () => { if (typeof document !== "undefined" && document.hidden) resetJoysticks(); };
  const onJoystickLostCapture = (event: PointerEvent) => {
    if (!activeGamePointers.delete(event.pointerId)) return;
    if (scrollDrag?.pointerId === event.pointerId) scrollDrag = null;
    joysticks.release(event.pointerId); uiControls.release(event.pointerId, true);
    for (const result of applyOverlayPointer(overlayPointerState, "cancel", [])) options.onSceneLayerPointer?.(result);
  };
  const onOverlayTouch = (event: TouchEvent) => {
    if (acceptsGameInput()) event.preventDefault();
  };
  /** Removes the game input listeners below; rollback and dispose both call it. */
  const detachGameInput = () => {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerCancel);
    canvas.removeEventListener("pointerleave", onPointerLeave);
    canvas.removeEventListener("touchstart", onOverlayTouch);
    canvas.removeEventListener("touchmove", onOverlayTouch);
    canvas.removeEventListener("wheel", onOverlayWheel);
    canvas.removeEventListener("lostpointercapture", onJoystickLostCapture);
    canvas.removeEventListener("blur", onCanvasBlur);
    canvas.removeEventListener("keydown", onControlKeyDown);
    canvas.removeEventListener("keyup", onControlKeyUp);
    if (typeof window !== "undefined") window.removeEventListener("blur", resetJoysticks);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onJoystickVisibility);
  };
  if (!options.editor) {
    onRollback(detachGameInput);
    canvas.addEventListener("pointerdown", onPointerDown);
    if (options.playMode && sceneLayerCompositor) {
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointercancel", onPointerCancel);
      canvas.addEventListener("pointerleave", onPointerLeave);
      canvas.addEventListener("touchstart", onOverlayTouch, { passive: false });
      canvas.addEventListener("touchmove", onOverlayTouch, { passive: false });
      canvas.addEventListener("wheel", onOverlayWheel, { passive: false });
      canvas.addEventListener("lostpointercapture", onJoystickLostCapture);
      canvas.addEventListener("blur", onCanvasBlur);
      canvas.addEventListener("keydown", onControlKeyDown);
      canvas.addEventListener("keyup", onControlKeyUp);
      if (canvas.tabIndex < 0) canvas.tabIndex = 0;
      if (typeof window !== "undefined") window.addEventListener("blur", resetJoysticks);
      if (typeof document !== "undefined") document.addEventListener("visibilitychange", onJoystickVisibility);
    }
  }
  return { ownsGamePointer, resetJoysticks, detach: detachGameInput };
}
