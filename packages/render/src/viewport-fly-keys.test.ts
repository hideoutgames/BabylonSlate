import { NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditorCamera } from "./editor-camera";
import { RenderScheduler } from "./render-scheduler";
import {
  attachViewportFlyKeys,
  DEFAULT_FLY_SPEED,
} from "./viewport-fly-keys";

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

function key(code: string, target: Record<string, unknown> = { tagName: "BODY" }) {
  return { code, target };
}

describe("attachViewportFlyKeys", () => {
  let engine: NullEngine;
  let scene: Scene;
  let scheduler: RenderScheduler;
  let target: FakeTarget;
  let canvas: { clientWidth: number };
  let frames: FrameRequestCallback[];
  let nowMs: number;

  beforeEach(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
    scheduler = new RenderScheduler();
    target = new FakeTarget();
    canvas = { clientWidth: 800 };
    frames = [];
    nowMs = 0;
  });

  afterEach(() => {
    scene.dispose();
    engine.dispose();
  });

  function attach(
    mode: "2d" | "3d" = "3d",
    options: Parameters<typeof attachViewportFlyKeys>[3] = {},
  ) {
    const controller = createEditorCamera(scene, { mode, scheduler });
    const handle = attachViewportFlyKeys(
      target as unknown as EventTarget,
      controller,
      canvas,
      {
        scheduler,
        requestFrame: (cb) => {
          frames.push(cb);
          return frames.length;
        },
        cancelFrame: () => {
          frames.length = 0;
        },
        ...options,
      },
    );
    return { controller, handle };
  }

  function pump(dtMs: number): void {
    const cb = frames.shift();
    if (!cb) throw new Error("no scheduled fly frame");
    nowMs += dtMs;
    cb(nowMs);
  }

  it("flies forward along look when W is held", () => {
    const { controller } = attach();
    controller.camera.getViewMatrix();
    const positionBefore = controller.camera.position.clone();
    const forward = controller.camera.getDirection(Vector3.Forward()).normalize();

    target.emit("keydown", key("KeyW"));
    pump(0);
    pump(16);
    controller.camera.getViewMatrix();

    const moved = controller.camera.position.subtract(positionBefore);
    expect(moved.length()).toBeCloseTo(DEFAULT_FLY_SPEED * 0.016, 3);
    expect(moved.normalize().dot(forward)).toBeCloseTo(1, 4);
  });

  it("strafes right when D is held", () => {
    const { controller } = attach();
    controller.camera.getViewMatrix();
    const positionBefore = controller.camera.position.clone();
    const right = controller.camera.getDirection(Vector3.Right()).normalize();

    target.emit("keydown", key("KeyD"));
    pump(0);
    pump(16);
    controller.camera.getViewMatrix();

    const moved = controller.camera.position.subtract(positionBefore);
    expect(moved.normalize().dot(right)).toBeCloseTo(1, 4);
  });

  it("holds a continuous lease while a fly key is down", () => {
    attach();
    target.emit("keydown", key("KeyW"));
    pump(0);
    expect(scheduler.shouldRender()).toBe(true);

    target.emit("keyup", key("KeyW"));
    scheduler.noteRendered();
    expect(scheduler.shouldRender()).toBe(false);
  });

  it("ignores WASD when the event target is a text field", () => {
    const { controller } = attach();
    const targetBefore = controller.camera.target.clone();

    target.emit("keydown", key("KeyW", { tagName: "INPUT" }));
    expect(frames).toHaveLength(0);
    expect(controller.camera.target.equals(targetBefore)).toBe(true);
  });

  it("ignores WASD when isEnabled returns false", () => {
    const { controller } = attach("3d", { isEnabled: () => false });
    const targetBefore = controller.camera.target.clone();

    target.emit("keydown", key("KeyW"));
    expect(frames).toHaveLength(0);
    expect(controller.camera.target.equals(targetBefore)).toBe(true);
  });

  it("ignores WASD when the canvas is hidden", () => {
    canvas.clientWidth = 0;
    const { controller } = attach();
    const targetBefore = controller.camera.target.clone();

    target.emit("keydown", key("KeyW"));
    expect(frames).toHaveLength(0);
    expect(controller.camera.target.equals(targetBefore)).toBe(true);
  });

  it("pans on XY in 2D when W and D are held", () => {
    const { controller } = attach("2d");
    const before = controller.camera.target.clone();

    target.emit("keydown", key("KeyW"));
    target.emit("keydown", key("KeyD"));
    pump(0);
    pump(16);

    expect(controller.camera.target.y).toBeGreaterThan(before.y);
    expect(controller.camera.target.x).toBeGreaterThan(before.x);
  });

  it("releases every listener on dispose", () => {
    const { handle } = attach();
    target.emit("keydown", key("KeyW"));
    handle.dispose();
    expect(target.listenerCount()).toBe(0);
    expect(frames).toHaveLength(0);
  });
});
