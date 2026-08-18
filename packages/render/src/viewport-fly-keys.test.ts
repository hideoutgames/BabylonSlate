import { NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditorCamera } from "./editor-camera";
import { RenderScheduler } from "./render-scheduler";
import {
  applyViewportJoystickSteer,
  attachViewportFlyKeys,
  DEFAULT_FLY_SPEED,
  DEFAULT_ORBIT_SPEED,
  lookDeltaFromFlyDelta,
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

  it("still flies with WASD when pivotAroundCenter is on", () => {
    const { controller } = attach();
    controller.setPivotAroundCenter(true);
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
});

describe("lookDeltaFromFlyDelta", () => {
  it("maps full-stick fly units to orbit radians at DEFAULT_ORBIT_SPEED", () => {
    const { deltaYaw, deltaPitch } = lookDeltaFromFlyDelta(DEFAULT_FLY_SPEED, 0);
    expect(deltaYaw).toBeCloseTo(0, 10);
    expect(deltaPitch).toBeCloseTo(DEFAULT_ORBIT_SPEED, 10);
  });

  it("yaws opposite stick-right the way one-finger look yaws opposite drag-right", () => {
    const { deltaYaw, deltaPitch } = lookDeltaFromFlyDelta(0, DEFAULT_FLY_SPEED);
    expect(deltaYaw).toBeCloseTo(-DEFAULT_ORBIT_SPEED, 10);
    expect(deltaPitch).toBeCloseTo(0, 10);
  });
});

describe("applyViewportJoystickSteer", () => {
  let engine: NullEngine;
  let scene: Scene;

  beforeEach(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
  });

  afterEach(() => {
    scene.dispose();
    engine.dispose();
  });

  it("flies when pivotAroundCenter is off", () => {
    const controller = createEditorCamera(scene, { mode: "3d" });
    controller.camera.getViewMatrix();
    const positionBefore = controller.camera.position.clone();
    const forward = controller.camera.getDirection(Vector3.Forward()).normalize();

    applyViewportJoystickSteer(controller, 2, 0);
    controller.camera.getViewMatrix();

    const moved = controller.camera.position.subtract(positionBefore);
    expect(moved.length()).toBeCloseTo(2, 4);
    expect(moved.normalize().dot(forward)).toBeCloseTo(1, 4);
  });

  it("orbits around the target in 3D when pivotAroundCenter is on", () => {
    const controller = createEditorCamera(scene, { mode: "3d" });
    controller.setPivotAroundCenter(true);
    controller.camera.getViewMatrix();
    const targetBefore = controller.camera.target.clone();
    const positionBefore = controller.camera.position.clone();
    const alphaBefore = controller.camera.alpha;

    applyViewportJoystickSteer(controller, 0, DEFAULT_FLY_SPEED);
    controller.camera.getViewMatrix();

    expect(controller.camera.alpha).toBeCloseTo(alphaBefore - DEFAULT_ORBIT_SPEED, 5);
    expect(controller.camera.target.x).toBeCloseTo(targetBefore.x, 5);
    expect(controller.camera.target.y).toBeCloseTo(targetBefore.y, 5);
    expect(controller.camera.target.z).toBeCloseTo(targetBefore.z, 5);
    expect(controller.camera.position.x).not.toBeCloseTo(positionBefore.x, 5);
  });

  it("still flies in 2D when pivotAroundCenter is on", () => {
    const controller = createEditorCamera(scene, { mode: "2d" });
    controller.setPivotAroundCenter(true);
    const before = controller.camera.target.clone();

    applyViewportJoystickSteer(controller, 3, 2);

    expect(controller.camera.target.x).toBeCloseTo(before.x + 2, 5);
    expect(controller.camera.target.y).toBeCloseTo(before.y + 3, 5);
  });
});
