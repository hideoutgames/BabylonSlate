import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { createCameraMotionProbe, observeViewInput } from "./view-activity";

type Listener = (event: Event) => void;

class FakeTarget {
  readonly listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new Event(type));
  }
  count(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}

function fakeCanvas() {
  const window = new FakeTarget();
  const document = { activeElement: null as unknown, defaultView: window };
  const canvas = Object.assign(new FakeTarget(), { ownerDocument: document });
  return { canvas, window, document };
}

describe("observeViewInput", () => {
  it("reports pointer, wheel, touch and key input over the canvas, and window keys only while hovered or focused", () => {
    const { canvas, window, document } = fakeCanvas();
    let activity = 0;
    const release = observeViewInput(canvas as unknown as HTMLElement, () => { activity += 1; });
    for (const type of ["pointerdown", "pointermove", "wheel", "touchstart", "keydown"]) canvas.emit(type);
    expect(activity).toBe(5);

    // Fly keys arrive on the window: they count only over the viewport.
    window.emit("keydown");
    expect(activity).toBe(5);
    canvas.emit("pointerenter");
    window.emit("keydown");
    expect(activity).toBe(7);
    canvas.emit("pointerleave");
    window.emit("keyup");
    expect(activity).toBe(7);
    document.activeElement = canvas;
    window.emit("keyup");
    expect(activity).toBe(8);

    release();
    expect([canvas.count(), window.count()]).toEqual([0, 0]);
  });

  it("observes a canvas outside a document, or whose document has no window, without throwing", () => {
    for (const ownerDocument of [undefined, null, { activeElement: null, defaultView: {} }]) {
      const canvas = Object.assign(new FakeTarget(), { ownerDocument });
      let activity = 0;
      const release = observeViewInput(canvas as unknown as HTMLElement, () => { activity += 1; });
      canvas.emit("pointerdown");
      expect(activity).toBe(1);
      release();
      expect(canvas.count()).toBe(0);
    }
  });
});

describe("createCameraMotionProbe", () => {
  it("reports a camera that moved or took the view, and nothing across frames that leave it still", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new FreeCamera("editor", new Vector3(0, 2, -10), scene);
    const other = new FreeCamera("other", new Vector3(5, 2, -10), scene);
    const moved = createCameraMotionProbe();
    try {
      scene.render();
      expect(moved(camera)).toBe(true);
      scene.render();
      scene.render();
      expect(moved(camera)).toBe(false);

      camera.position.x += 1;
      scene.render();
      expect(moved(camera)).toBe(true);
      scene.render();
      expect(moved(camera)).toBe(false);

      camera.rotation.y += 0.1;
      scene.render();
      expect(moved(camera)).toBe(true);

      expect(moved(other)).toBe(true);
      expect(moved(other)).toBe(false);
      expect(moved(null)).toBe(true);
      expect(moved(null)).toBe(false);
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
});
