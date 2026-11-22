import type { Scene } from "@babylonjs/core/scene";
import type { OverlayPointerHit } from "@haptic/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Joystick2DInput } from "./joystick2d-input";
import type { OverlayLayoutRenderer } from "./overlay-layout-render";
import { createPlayGameInput } from "./play-game-input";
import type { SceneLayerCompositor } from "./scene-layer-compositor";
import { createOverlayPointerState, type OverlayPointerDispatch } from "./scene-layer-pointer";
import type { UIControls2DInput } from "./ui-controls2d-input";

/** An event target that records its listeners; the babylon test project runs in Node, without a DOM. */
class FakeTarget {
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of [...this.listeners.get(type) ?? []]) listener({ preventDefault() {}, ...event });
  }
  listenerCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }
}

const buttonHit: OverlayPointerHit = { layerId: "hud", actorGuid: "button", hasButton: true, hitTest: "block" } as OverlayPointerHit;

/**
 * Play's game input over fakes of the collaborators it drives: the stick
 * and control inputs record what they are told, and an overlay press on the
 * left half of the canvas lands on a joystick, on the right half on a button.
 */
function fixture({ compositor = true } = {}) {
  const view = new FakeTarget();
  const document = Object.assign(new FakeTarget(), { hidden: false, defaultView: view, pointerLockElement: null });
  // Play listens on the page's window and document.
  vi.stubGlobal("window", view);
  vi.stubGlobal("document", document);
  const captured = new Set<number>();
  const released: number[] = [];
  const canvas = Object.assign(new FakeTarget(), {
    ownerDocument: document,
    tabIndex: 0,
    focus() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    setPointerCapture: (id: number) => { captured.add(id); },
    releasePointerCapture: (id: number) => { captured.delete(id); released.push(id); },
  });
  const sticks = new Set<number>();
  const joysticks = {
    owns: (id: number) => sticks.has(id),
    move: (id: number) => sticks.has(id),
    release: vi.fn((id: number) => sticks.delete(id)),
    reset: vi.fn(() => sticks.clear()),
  };
  const editor = { name: "native text editor" };
  const uiControls = {
    owns: () => false,
    allowsScroll: () => true,
    move: () => false,
    release: vi.fn(() => false),
    reset: vi.fn(),
    cancelForScroll: vi.fn(),
    keyDown: vi.fn(),
    ownsElement: (element: unknown) => element === editor,
  };
  const overlayPointerState = createOverlayPointerState();
  const overlayEvents: OverlayPointerDispatch[] = [];
  const dispatched: string[] = [];
  let accepting = true;
  const dispatchOverlayPointer = (phase: string, x: number, _y: number, pointerId?: number) => {
    dispatched.push(phase);
    if (phase === "down" && pointerId !== undefined) {
      if (x < 50) sticks.add(pointerId);
      else overlayPointerState.pressed.set("button", buttonHit);
    }
    return false;
  };
  const scrollTarget = { actorId: "list", componentId: "scroll", scroll: { scaleX: 1, scaleY: 1 } };
  const scrolls: Array<{ deltaY: number }> = [];
  const input = createPlayGameInput({
    canvas: canvas as unknown as HTMLCanvasElement,
    scene: { getEngine: () => ({ getHardwareScalingLevel: () => 1, getRenderWidth: () => 100, getRenderHeight: () => 100 }) } as unknown as Scene,
    options: { playMode: true, onSceneLayerPointer: (event) => overlayEvents.push(event), onSceneLayerScroll: (event) => scrolls.push(event) },
    pointerCanvas: () => ({ width: 100, height: 100 }),
    sceneLayerCompositor: compositor
      ? {
          pickHits: () => [],
          sortedLayers: () => [{ layerId: "hud", viewBounds: { width: 100, height: 100 }, cameraState: { x: 0, y: 0, rotation: 0, zoom: 1 } }],
        } as unknown as SceneLayerCompositor
      : null,
    layerLoads: new Map(),
    overlayLayouts: { scrollAt: () => scrollTarget } as unknown as OverlayLayoutRenderer,
    acceptsGameInput: () => accepting,
    joysticks: joysticks as unknown as Joystick2DInput,
    uiControls: uiControls as unknown as UIControls2DInput,
    playCursor: null,
    dispatchOverlayPointer,
    overlayPointerState,
    onRollback: () => {},
  });
  const pointer = (type: string, pointerId: number, x: number, y = 50) =>
    canvas.emit(type, { pointerId, clientX: x, clientY: y, pointerType: "touch", buttons: type === "pointerup" ? 0 : 1 });
  return {
    canvas, view, document, captured, released, joysticks, uiControls, editor, overlayPointerState, overlayEvents, dispatched, scrolls, input, pointer,
    pause: () => { accepting = false; },
  };
}

describe("createPlayGameInput", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("lets go of a stick, a scroll and 2D presses held by a finger that lifts while the game takes no input, and delivers nothing", () => {
    const { joysticks, uiControls, overlayPointerState, overlayEvents, dispatched, input, pointer, pause } = fixture();
    pointer("pointerdown", 1, 10);
    pointer("pointerdown", 2, 80);
    expect(input.ownsGamePointer(1)).toBe(true);
    expect(overlayPointerState.pressed.size).toBe(1);
    // Paused by a caller that has not reset the view's input.
    pause();
    dispatched.length = 0;
    pointer("pointerup", 1, 10);
    expect(joysticks.release).toHaveBeenCalledWith(1);
    expect(input.ownsGamePointer(1)).toBe(false);
    expect(uiControls.release).toHaveBeenCalledWith(1, true);
    pointer("pointercancel", 2, 80);
    // The button's press ends as a cancel: no click, and no up or move reaches the overlays.
    expect(overlayEvents).toEqual([{ layerId: "hud", actorGuid: "button", event: "onPressEnd" }]);
    expect(overlayPointerState.pressed.size).toBe(0);
    expect(dispatched).toEqual([]);
  });

  it("keeps a scroll drag with its first finger when a second finger lands on the scroll box", () => {
    const { input, pointer, scrolls } = fixture();
    pointer("pointerdown", 1, 80, 50);
    pointer("pointermove", 1, 80, 30);
    expect(input.ownsGamePointer(1)).toBe(true);
    pointer("pointerdown", 2, 70, 50);
    pointer("pointermove", 1, 80, 20);
    expect(scrolls).toHaveLength(2);
    expect(input.ownsGamePointer(1)).toBe(true);
    expect(input.ownsGamePointer(2)).toBe(false);
    pointer("pointerup", 1, 80, 20);
    expect(input.ownsGamePointer(1)).toBe(false);
  });

  it("releases the sticks, and their fingers, when a 2D Text Input's editor takes focus", () => {
    const { canvas, joysticks, uiControls, released, dispatched, input, pointer, editor } = fixture();
    pointer("pointerdown", 1, 10);
    pointer("pointerdown", 2, 80);
    canvas.emit("blur", { relatedTarget: editor });
    expect(joysticks.reset).toHaveBeenCalledTimes(1);
    expect(input.ownsGamePointer(1)).toBe(false);
    expect(released).toEqual([1]);
    // The text control keeps its own pointer and focus.
    expect(uiControls.reset).not.toHaveBeenCalled();
    // The stick's finger reaches neither the overlays nor the stick until it lifts.
    dispatched.length = 0;
    pointer("pointermove", 1, 20);
    pointer("pointerup", 1, 20);
    expect(dispatched).toEqual([]);
    expect(joysticks.release).not.toHaveBeenCalled();
  });

  it("ends tracked presses in a view without Scene Layers, releases them when the page loses focus, and detaches every listener", () => {
    const { canvas, view, document, released, input, pointer } = fixture({ compositor: false });
    pointer("pointerdown", 1, 80);
    pointer("pointerup", 1, 80);
    pointer("pointerdown", 2, 80);
    pointer("pointercancel", 2, 80);
    pointer("pointerdown", 3, 80);
    view.emit("blur");
    // Only the press still down is released; ended ones are no longer tracked.
    expect(released).toEqual([3]);
    pointer("pointerdown", 4, 80);
    document.hidden = true;
    document.emit("visibilitychange");
    expect(released).toEqual([3, 4]);
    input.detach();
    expect(canvas.listenerCount() + view.listenerCount() + document.listenerCount()).toBe(0);
  });
});
