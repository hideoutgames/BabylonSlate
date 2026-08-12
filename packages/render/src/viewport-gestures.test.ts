import { NullEngine, Scene } from "@babylonjs/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("treats a moved single finger as a marquee in 2D and not a tap", () => {
    const taps: Array<[number, number]> = [];
    const marquees: Array<{
      x: number;
      y: number;
      width: number;
      height: number;
    }> = [];
    attach("2d", {
      onTap: (x, y) => taps.push([x, y]),
      onMarquee: (rect) => marquees.push(rect),
    });

    canvas.emit("pointerdown", pointer(1, 100, 100));
    canvas.emit("pointermove", pointer(1, 60, 140));
    canvas.emit("pointerup", pointer(1, 60, 140));

    expect(taps).toHaveLength(0);
    expect(marquees).toEqual([{ x: 60, y: 100, width: 40, height: 40 }]);
  });

  it("does not marquee in 3D, where a single-finger drag has no meaning", () => {
    const marquees: unknown[] = [];
    attach("3d", { onMarquee: (rect) => marquees.push(rect) });

    canvas.emit("pointerdown", pointer(1, 100, 100));
    canvas.emit("pointermove", pointer(1, 200, 200));
    canvas.emit("pointerup", pointer(1, 200, 200));

    expect(marquees).toHaveLength(0);
  });

  it("orbits on a two-finger drag in 3D and holds a continuous lease", () => {
    const { controller } = attach("3d");
    const alphaBefore = controller.camera.alpha;

    canvas.emit("pointerdown", pointer(1, 100, 100));
    canvas.emit("pointerdown", pointer(2, 200, 100));
    expect(scheduler.shouldRender()).toBe(true);

    canvas.emit("pointermove", pointer(1, 140, 100));
    canvas.emit("pointermove", pointer(2, 240, 100));

    expect(controller.camera.alpha).not.toBeCloseTo(alphaBefore, 6);

    canvas.emit("pointerup", pointer(1, 140, 100));
    canvas.emit("pointerup", pointer(2, 240, 100));
    scheduler.noteRendered();
    expect(scheduler.shouldRender()).toBe(false);
  });

  it("pans instead of orbiting on a two-finger drag in 2D", () => {
    const { controller } = attach("2d");
    const alphaBefore = controller.camera.alpha;
    const targetBefore = controller.camera.target.clone();

    canvas.emit("pointerdown", pointer(1, 100, 100));
    canvas.emit("pointerdown", pointer(2, 200, 100));
    canvas.emit("pointermove", pointer(1, 140, 100));
    canvas.emit("pointermove", pointer(2, 240, 100));

    expect(controller.camera.alpha).toBeCloseTo(alphaBefore, 6);
    expect(controller.camera.target.equals(targetBefore)).toBe(false);
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
