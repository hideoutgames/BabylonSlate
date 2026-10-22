import { describe, expect, it } from "vitest";
import { InputResolver } from "./resolver";
import type { RawInputEvent } from "./ring-buffer";

const TICK = 1 / 60;
const ACTIONS = ["tap", "double-tap", "long-press", "swipe-up", "swipe-down", "swipe-left", "swipe-right"];

/** Every gesture bound to an input named after its code, as a game would bind them. */
function gestureResolver() {
  const resolver = new InputResolver({
    actions: ACTIONS.map((code) => ({ name: code, bindings: [{ device: "touch", code }] })),
    axes: [
      { name: "pinch", kind: "1d", bindings: [{ device: "touch", code: "pinch" }] },
      { name: "rotate", kind: "1d", bindings: [{ device: "touch", code: "two-finger-rotate" }] },
      { name: "drag", kind: "2d", bindings: [
        { device: "touch", code: "two-finger-drag-x", component: "x" },
        { device: "touch", code: "two-finger-drag-y", component: "y" },
      ] },
    ],
  });
  const tick = (...events: RawInputEvent[]) => resolver.resolve(events, TICK);
  const idle = (ticks: number) => { for (let i = 0; i < ticks; i++) tick(); };
  return { resolver, tick, idle };
}

const finger = (pointerId: number, phase: "down" | "move" | "up" | "cancel", x: number, y: number): RawInputEvent =>
  ({ kind: "pointer", tick: 0, pointerId, phase, x, y, button: phase === "move" ? -1 : 0, pointerType: "touch" });

const started = (resolved: ReturnType<InputResolver["resolve"]>) =>
  ACTIONS.filter((code) => resolved.actions[code]?.pressed);

describe("touch gestures", () => {
  it("taps a quick lift in place, double-taps a second tap close by soon after, then starts over", () => {
    const { tick, idle } = gestureResolver();
    tick(finger(1, "down", 100, 100));
    const first = tick(finger(1, "up", 103, 101));
    expect(started(first)).toEqual(["tap"]);
    expect(first.actions.tap).toMatchObject({ held: true, pressed: true });
    expect(tick().actions.tap).toMatchObject({ held: false, released: true });
    idle(5);
    tick(finger(2, "down", 110, 104));
    expect(started(tick(finger(2, "up", 110, 104)))).toEqual(["tap", "double-tap"]);
    idle(5);
    tick(finger(3, "down", 110, 104));
    expect(started(tick(finger(3, "up", 110, 104)))).toEqual(["tap"]);
  });

  it("starts a pulse again when it repeats on the very next tick", () => {
    const { tick } = gestureResolver();
    expect(started(tick(finger(1, "down", 50, 50), finger(1, "up", 50, 50)))).toEqual(["tap"]);
    const again = tick(finger(2, "down", 50, 50), finger(2, "up", 50, 50));
    // The first tap releases as the tick starts, so the second one starts the input again.
    expect(again.actions.tap).toEqual({ held: true, pressed: true, released: true });
    expect(started(again)).toEqual(["tap", "double-tap"]);
  });

  it("does not tap a press that moved beyond the slop or lasted half a second", () => {
    const { tick, idle } = gestureResolver();
    tick(finger(1, "down", 100, 100));
    tick(finger(1, "move", 120, 100));
    expect(started(tick(finger(1, "up", 101, 100)))).toEqual([]);
    tick(finger(2, "down", 100, 100));
    idle(30);
    expect(started(tick(finger(2, "up", 100, 100)))).toEqual([]);
  });

  it("holds Long Press from half a second until the lift, through later movement, without a tap or swipe", () => {
    const { tick, idle } = gestureResolver();
    tick(finger(1, "down", 100, 100));
    idle(28);
    expect(tick().actions["long-press"]?.held).toBe(false);
    expect(tick().actions["long-press"]).toMatchObject({ held: true, pressed: true });
    expect(tick(finger(1, "move", 300, 100)).actions["long-press"]?.held).toBe(true);
    const lift = tick(finger(1, "up", 300, 30));
    expect(lift.actions["long-press"]).toMatchObject({ held: false, released: true });
    expect(started(lift)).toEqual([]);
  });

  it("never long-presses when a second finger arrives first", () => {
    const { tick, idle } = gestureResolver();
    tick(finger(1, "down", 100, 100));
    tick(finger(2, "down", 300, 100));
    tick(finger(2, "up", 300, 100));
    idle(40);
    expect(tick().actions["long-press"]?.held).toBe(false);
  });

  it("swipes in the dominant direction of a quick move, with the flick's velocity on the lift", () => {
    const { tick } = gestureResolver();
    tick(finger(1, "down", 100, 100));
    tick(finger(1, "move", 110, 60));
    const lift = tick(finger(1, "up", 115, 20));
    expect(started(lift)).toEqual(["swipe-up"]);
    const ended = lift.touchEvents.find((touch) => touch.Phase === "Ended")!;
    // Two ticks of 40 px each, smoothed: (2400 + 2400 / 2) / 2 px per second upward.
    expect(ended.Velocity.y).toBeCloseTo(-1800);

    tick(finger(2, "down", 100, 100));
    expect(started(tick(finger(2, "up", 30, 110)))).toEqual(["swipe-left"]);
  });

  it("does not swipe a slow drag, or a contact that shared the screen with another", () => {
    const { tick } = gestureResolver();
    tick(finger(1, "down", 100, 100));
    for (let step = 1; step <= 40; step++) tick(finger(1, "move", 100 + step * 5, 100));
    expect(started(tick(finger(1, "up", 300, 100)))).toEqual([]);

    // Two fingers flicking together are a two-finger drag, not two swipes; tapping together is not a tap.
    tick(finger(2, "down", 100, 100), finger(3, "down", 200, 100));
    expect(started(tick(finger(2, "up", 100, 20), finger(3, "up", 200, 20)))).toEqual([]);
    tick(finger(4, "down", 100, 100), finger(5, "down", 200, 100));
    expect(started(tick(finger(4, "up", 100, 100), finger(5, "up", 200, 100)))).toEqual([]);
  });

  it("measures pinch, rotation and drag of the two lowest fingers each tick once both are down", () => {
    const { resolver, tick } = gestureResolver();
    resolver.setViewSize(800, 600);
    const both = tick(finger(1, "down", 100, 100), finger(2, "down", 200, 100));
    expect(both.axes.pinch).toBe(0);

    const spread = tick(finger(2, "move", 220, 100));
    expect(spread.axes.pinch).toBeCloseTo(0.2);
    expect(spread.axes2D.drag!.x).toBeCloseTo(10 / 600);

    // Finger 2 turns 0.1 rad clockwise about finger 1 (screen y points down).
    const turned = tick(finger(2, "move", 100 + 120 * Math.cos(0.1), 100 + 120 * Math.sin(0.1)));
    expect(turned.axes.rotate).toBeCloseTo(0.1);
    expect(turned.axes.pinch).toBeCloseTo(0);

    // Both move up 30 px: up is positive, like a joystick. A third finger does not change the pair.
    const raised = tick(finger(1, "move", 100, 70), finger(2, "move", 100 + 120 * Math.cos(0.1), 70 + 120 * Math.sin(0.1)), finger(3, "down", 400, 400));
    expect(raised.axes2D.drag!.y).toBeCloseTo(30 / 600);
    expect(raised.inputs.drag?.held).toBe(true);

    expect(tick().axes2D.drag).toEqual({ x: 0, y: 0 });
  });

  it("keeps two-finger drag at zero until the view size is known", () => {
    const { tick } = gestureResolver();
    tick(finger(1, "down", 100, 100), finger(2, "down", 200, 100));
    const moved = tick(finger(1, "move", 150, 100), finger(2, "move", 250, 100));
    expect(moved.axes2D.drag).toEqual({ x: 0, y: 0 });
  });
});

describe("gesture bindings", () => {
  it("lets one action take a swipe and a key, and releases neither while the other holds it", () => {
    const resolver = new InputResolver({ actions: [{ name: "Jump", bindings: [
      { device: "key", code: "Space" },
      { device: "touch", code: "swipe-up" },
    ] }], axes: [] });
    const tick = (...events: RawInputEvent[]) => resolver.resolve(events, TICK);
    tick(finger(1, "down", 100, 200));
    expect(tick(finger(1, "up", 100, 100)).actions.Jump).toMatchObject({ held: true, pressed: true });
    expect(tick().actions.Jump).toMatchObject({ held: false, released: true });
    expect(tick({ kind: "key", tick: 0, code: "Space", phase: "down" }).actions.Jump.pressed).toBe(true);
    tick(finger(2, "down", 100, 200));
    tick(finger(2, "up", 100, 100));
    expect(tick().actions.Jump).toMatchObject({ held: true, released: false });
  });
});
