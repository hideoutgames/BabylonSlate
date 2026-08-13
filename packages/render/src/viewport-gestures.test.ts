import { NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEditorCamera } from "./editor-camera";
import { RenderScheduler } from "./render-scheduler";
import { attachViewportGestures } from "./viewport-gestures";

type Listener = (event: Event) => void;

/**
 * The babylon Vitest project runs under Node, so gestures are exercised against
 * a canvas stub rather than jsdom; only the listener surface is used.
 */
class FakeCanvas {
  readonly listeners = new Map<string, Set<Listener>>();
  capturedPointers: number[] = [];

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  setPointerCapture(pointerId: number): void {
    this.capturedPointers.push(pointerId);
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 600 };
  }

  emit(type: string, event: Record<string, unknown>): void {
    const payload = { preventDefault: () => {}, ...event } as unknown as Event;
    for (const listener of this.listeners.get(type) ?? []) {
      listener(payload);
    }
  }

  listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}

function pointer(pointerId: number, x: number, y: number) {
  return { pointerId, clientX: x, clientY: y };
}

describe("attachViewportGestures", () => {
  let engine: NullEngine;
  let scene: Scene;
  let canvas: FakeCanvas;
  let scheduler: RenderScheduler;

  beforeEach(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
    canvas = new FakeCanvas();
    scheduler = new RenderScheduler();
  });

  afterEach(() => {
    scene.dispose();
    engine.dispose();
  });

  function attach(
    mode: "2d" | "3d",
    options: Parameters<typeof attachViewportGestures>[2] = {},
  ) {
    const controller = createEditorCamera(scene, { mode, scheduler });
    const handle = attachViewportGestures(
      canvas as unknown as HTMLCanvasElement,
      controller,
      { scheduler, ...options },
    );
    return { controller, handle };
  }

  it("reports a stationary single-finger tap in canvas coordinates", () => {
    const taps: Array<[number, number]> = [];
    attach("3d", { onTap: (x, y) => taps.push([x, y]) });

    canvas.emit("pointerdown", pointer(1, 120, 90));
    canvas.emit("pointermove", pointer(1, 122, 92));
    canvas.emit("pointerup", pointer(1, 122, 92));

    expect(taps).toEqual([[122, 92]]);
    expect(canvas.capturedPointers).toEqual([1]);
  });

  it("pans on a moved single finger in 2D and does not marquee", () => {
    const taps: Array<[number, number]> = [];
    const marquees: Array<{
      x: number;
      y: number;
      width: number;
      height: number;
    }> = [];
    const { controller } = attach("2d", {
      onTap: (x, y) => taps.push([x, y]),
      onMarquee: (rect) => marquees.push(rect),
    });
    const targetBefore = controller.camera.target.clone();

    canvas.emit("pointerdown", pointer(1, 100, 100));
    canvas.emit("pointermove", pointer(1, 60, 140));
    canvas.emit("pointerup", pointer(1, 60, 140));

    expect(taps).toHaveLength(0);
    expect(marquees).toHaveLength(0);
    expect(controller.camera.target.equals(targetBefore)).toBe(false);
  });

  it("pans 2D one-finger drags 1:1 with the orthographic frustum", () => {
    const { controller } = attach("2d");
    // FakeCanvas is 800×600; default 2D frustum is 8×8 (half-height 4, aspect 1).
    canvas.emit("pointerdown", pointer(1, 100, 100));
    canvas.emit("pointermove", pointer(1, 60, 140));
    canvas.emit("pointerup", pointer(1, 60, 140));

    expect(controller.camera.target.x).toBeCloseTo(40 * (8 / 800), 5);
    expect(controller.camera.target.y).toBeCloseTo(40 * (8 / 600), 5);
  });

  it("pans a larger world delta in 2D when the frustum is zoomed out", () => {
    const { controller } = attach("2d");
    controller.setOrthoHalfHeight(16);

    canvas.emit("pointerdown", pointer(1, 100, 100));
    canvas.emit("pointermove", pointer(1, 60, 140));
    canvas.emit("pointerup", pointer(1, 60, 140));

    expect(controller.camera.target.x).toBeCloseTo(40 * (32 / 800), 5);
    expect(controller.camera.target.y).toBeCloseTo(40 * (32 / 600), 5);
  });

  it("marquees in 2D after a 250ms hold then move", () => {
    vi.useFakeTimers();
    const marquees: Array<{
      x: number;
      y: number;
      width: number;
      height: number;
    }> = [];
    const { controller } = attach("2d", {
      onMarquee: (rect) => marquees.push(rect),
    });
    const targetBefore = controller.camera.target.clone();

    canvas.emit("pointerdown", pointer(1, 100, 100));
    vi.advanceTimersByTime(250);
    canvas.emit("pointermove", pointer(1, 60, 140));
    canvas.emit("pointerup", pointer(1, 60, 140));

    expect(marquees).toEqual([{ x: 60, y: 100, width: 40, height: 40 }]);
    expect(controller.camera.target.equals(targetBefore)).toBe(true);
    vi.useRealTimers();
  });

  it("does not pan in 2D when blockLook reports a gizmo hit", () => {
    const { controller } = attach("2d", { blockLook: () => true });
    const targetBefore = controller.camera.target.clone();

    canvas.emit("pointerdown", pointer(1, 100, 100));
    canvas.emit("pointermove", pointer(1, 60, 140));
    canvas.emit("pointerup", pointer(1, 60, 140));

    expect(controller.camera.target.equals(targetBefore)).toBe(true);
  });

  it("does not marquee in 3D, where a single-finger drag looks instead", () => {
    const marquees: unknown[] = [];
    attach("3d", { onMarquee: (rect) => marquees.push(rect) });

    canvas.emit("pointerdown", pointer(1, 100, 100));
    canvas.emit("pointermove", pointer(1, 200, 200));
    canvas.emit("pointerup", pointer(1, 200, 200));

    expect(marquees).toHaveLength(0);
  });

  it("looks in place on a one-finger drag in 3D and holds a continuous lease", () => {
    const { controller } = attach("3d");
    controller.camera.getViewMatrix();
    const positionBefore = controller.camera.position.clone();
    const alphaBefore = controller.camera.alpha;

    canvas.emit("pointerdown", pointer(1, 100, 100));
    canvas.emit("pointermove", pointer(1, 160, 100));
    expect(scheduler.shouldRender()).toBe(true);

    controller.camera.getViewMatrix();
    expect(controller.camera.alpha).not.toBeCloseTo(alphaBefore, 6);
    expect(controller.camera.position.x).toBeCloseTo(positionBefore.x, 4);
    expect(controller.camera.position.y).toBeCloseTo(positionBefore.y, 4);
    expect(controller.camera.position.z).toBeCloseTo(positionBefore.z, 4);

    canvas.emit("pointerup", pointer(1, 160, 100));
    scheduler.noteRendered();
    expect(scheduler.shouldRender()).toBe(false);
  });

  it("does not look when blockLook reports the pointer is on a gizmo", () => {
    const { controller } = attach("3d", { blockLook: () => true });
    const alphaBefore = controller.camera.alpha;

    canvas.emit("pointerdown", pointer(1, 100, 100));
    canvas.emit("pointermove", pointer(1, 160, 100));
    canvas.emit("pointerup", pointer(1, 160, 100));

    expect(controller.camera.alpha).toBeCloseTo(alphaBefore, 6);
  });

  it("does not orbit or pan on a two-finger drag without a pinch", () => {
    const { controller } = attach("3d");
    const alphaBefore = controller.camera.alpha;
    const targetBefore = controller.camera.target.clone();

    canvas.emit("pointerdown", pointer(1, 100, 100));
    canvas.emit("pointerdown", pointer(2, 200, 100));
    expect(scheduler.shouldRender()).toBe(true);

    canvas.emit("pointermove", pointer(1, 140, 100));
    canvas.emit("pointermove", pointer(2, 240, 100));

    expect(controller.camera.alpha).toBeCloseTo(alphaBefore, 6);
    expect(controller.camera.target.equals(targetBefore)).toBe(true);

    canvas.emit("pointerup", pointer(1, 140, 100));
    canvas.emit("pointerup", pointer(2, 240, 100));
    scheduler.noteRendered();
    expect(scheduler.shouldRender()).toBe(false);
  });

  it("does not pan on a two-finger drag in 2D without a pinch", () => {
    const { controller } = attach("2d");
    const alphaBefore = controller.camera.alpha;
    const targetBefore = controller.camera.target.clone();

    canvas.emit("pointerdown", pointer(1, 100, 100));
    canvas.emit("pointerdown", pointer(2, 200, 100));
    canvas.emit("pointermove", pointer(1, 140, 100));
    canvas.emit("pointermove", pointer(2, 240, 100));

    expect(controller.camera.alpha).toBeCloseTo(alphaBefore, 6);
    expect(controller.camera.target.equals(targetBefore)).toBe(true);
  });

  it("pans on a three-finger drag", () => {
    const { controller } = attach("3d");
    controller.camera.getViewMatrix();
    const targetBefore = controller.camera.target.clone();
    const right = controller.camera.getDirection(Vector3.Right()).clone();
    const up = controller.camera.getDirection(Vector3.Up()).clone();

    canvas.emit("pointerdown", pointer(1, 100, 100));
    canvas.emit("pointerdown", pointer(2, 200, 100));
    canvas.emit("pointerdown", pointer(3, 150, 180));
    canvas.emit("pointermove", pointer(1, 140, 100));
    canvas.emit("pointermove", pointer(2, 240, 100));
    canvas.emit("pointermove", pointer(3, 190, 180));

    // Midpoint moved +40px in X; 3D still uses panScale 0.01.
    const expected = targetBefore
      .add(right.scale(-40 * 0.01))
      .add(up.scale(0));
    expect(controller.camera.target.x).toBeCloseTo(expected.x, 5);
    expect(controller.camera.target.y).toBeCloseTo(expected.y, 5);
    expect(controller.camera.target.z).toBeCloseTo(expected.z, 5);
  });

  it("pans 2D three-finger drags at the same 1:1 frustum scale", () => {
    const { controller } = attach("2d");

    canvas.emit("pointerdown", pointer(1, 100, 100));
    canvas.emit("pointerdown", pointer(2, 200, 100));
    canvas.emit("pointerdown", pointer(3, 150, 180));
    canvas.emit("pointermove", pointer(1, 100, 160));
    canvas.emit("pointermove", pointer(2, 200, 160));
    canvas.emit("pointermove", pointer(3, 150, 240));

    expect(controller.camera.target.x).toBeCloseTo(0, 5);
    expect(controller.camera.target.y).toBeCloseTo(60 * (8 / 600), 5);
  });

  it("zooms when the pinch spread changes", () => {
    const { controller } = attach("2d");
    const halfHeightBefore = controller.orthoHalfHeight();

    canvas.emit("pointerdown", pointer(1, 100, 100));
    canvas.emit("pointerdown", pointer(2, 200, 100));
    canvas.emit("pointermove", pointer(1, 50, 100));
    canvas.emit("pointermove", pointer(2, 250, 100));

    expect(controller.orthoHalfHeight()).toBeLessThan(halfHeightBefore);
  });

  it("pinch-zooms a pixel-perfect 2D camera through integer steps", () => {
    const { controller } = attach("2d");
    controller.setCanvasHeight(600);
    controller.setPixelPerfect({ pixelsPerUnit: 100, integerZoomSteps: true });

    canvas.emit("pointerdown", pointer(1, 0, 100));
    canvas.emit("pointerdown", pointer(2, 100, 100));
    // 1.1^5 ≈ 1.61 crosses the integer-step threshold; one 2× jump would hide
    // the accumulation bug that makes gradual pinch a no-op.
    let spread = 100;
    for (let i = 0; i < 5; i++) {
      spread *= 1.1;
      canvas.emit("pointermove", pointer(1, 0, 100));
      canvas.emit("pointermove", pointer(2, spread, 100));
    }

    expect(controller.pixelZoom()).toBe(2);
    expect(controller.orthoHalfHeight()).toBe(1.5);
  });

  it("prevents default on touchstart and touchmove so iOS does not delay pointer events", () => {
    attach("3d");
    const start = { preventDefault: vi.fn(), touches: [{ identifier: 1 }] };
    canvas.emit("touchstart", start);
    expect(start.preventDefault).toHaveBeenCalled();

    const move = { preventDefault: vi.fn(), touches: [{ identifier: 1 }, { identifier: 2 }] };
    canvas.emit("touchmove", move);
    expect(move.preventDefault).toHaveBeenCalled();
  });

  it("zooms on wheel and releases every listener on dispose", () => {
    const { controller, handle } = attach("3d");
    const radiusBefore = controller.camera.radius;

    canvas.emit("wheel", { deltaY: -100 });
    expect(controller.camera.radius).toBeLessThan(radiusBefore);

    handle.dispose();
    expect(canvas.listenerCount()).toBe(0);
  });

  it("ignores a cancelled pointer that was never captured", () => {
    const taps: unknown[] = [];
    attach("3d", { onTap: (x, y) => taps.push([x, y]) });

    canvas.emit("pointermove", pointer(9, 10, 10));
    canvas.emit("pointercancel", pointer(9, 10, 10));

    expect(taps).toHaveLength(0);
  });
});
