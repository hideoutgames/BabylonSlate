import { describe, expect, it } from "vitest";
import { InputResolver } from "./resolver";
import type { RawInputEvent } from "./ring-buffer";

const TICK = 1 / 60;

function motion(values: Partial<Extract<RawInputEvent, { kind: "motion" }>> = {}): RawInputEvent {
  return {
    kind: "motion", tick: 0, beta: 0, gamma: 0, screenAngle: 0, accelerationX: 0, accelerationY: 0, accelerationZ: 0,
    peakAcceleration: 0, rotationX: 0, rotationY: 0, rotationZ: 0, ...values,
  };
}

function motionResolver() {
  const resolver = new InputResolver({
    actions: [{ name: "Shake", bindings: [{ device: "touch", code: "shake" }] }],
    axes: [{ name: "Tilt", kind: "2d", bindings: [
      { device: "touch", code: "tilt-x", component: "x" },
      { device: "touch", code: "tilt-y", component: "y" },
    ] }],
  });
  return { resolver, tick: (...events: RawInputEvent[]) => resolver.resolve(events, TICK) };
}

describe("device motion", () => {
  it("tilts right and away as positive, in the screen's axes, from the calibrated pose", () => {
    const { resolver, tick } = motionResolver();
    // Right side 15° down and top edge 15° away from lying flat: half of a full 30° tilt each way.
    const portrait = tick(motion({ beta: -15, gamma: 15 }));
    expect(portrait.axes2D.Tilt!.x).toBeCloseTo(0.5);
    expect(portrait.axes2D.Tilt!.y).toBeCloseTo(0.5);
    expect(portrait.deviceMotion.tilt.x).toBeCloseTo(0.5);

    // The same pose with the screen turned to landscape (90°): the device's right is the screen's up.
    const landscape = tick(motion({ beta: -15, gamma: 15, screenAngle: 90 }));
    expect(landscape.axes2D.Tilt!.x).toBeCloseTo(-0.5);
    expect(landscape.axes2D.Tilt!.y).toBeCloseTo(0.5);

    // Held up at 60°, calibrated, then tipped 15° away.
    tick(motion({ beta: 60 }));
    resolver.calibrateTilt();
    expect(tick(motion({ beta: 60 })).axes2D.Tilt).toEqual({ x: 0, y: 0 });
    expect(tick(motion({ beta: 45 })).axes2D.Tilt!.y).toBeCloseTo(0.5);
    // Calibration outlives an input reset.
    resolver.reset();
    expect(tick(motion({ beta: 60 })).axes2D.Tilt).toEqual({ x: 0, y: 0 });
  });

  it("reports acceleration and rotation rate in screen axes, and nothing once a sample has no reading", () => {
    const { tick } = motionResolver();
    const turned = tick(motion({ screenAngle: 90, accelerationX: 2, accelerationZ: -1, rotationX: 10, rotationZ: 5 }));
    expect(turned.deviceMotion.available).toBe(true);
    expect(turned.deviceMotion.acceleration.x).toBeCloseTo(0);
    expect(turned.deviceMotion.acceleration.y).toBeCloseTo(2);
    expect(turned.deviceMotion.acceleration.z).toBe(-1);
    expect(turned.deviceMotion.rotationRate.y).toBeCloseTo(10);
    expect(turned.deviceMotion.rotationRate.z).toBe(5);

    tick(motion({ beta: -30 }));
    const released = tick(motion({ beta: Number.NaN, gamma: Number.NaN }));
    expect(released.deviceMotion.available).toBe(false);
    expect(released.inputs.Tilt).toMatchObject({ held: false, released: true });
  });

  it("shakes once three strong readings land within half a second, then rests before the next", () => {
    const { tick } = motionResolver();
    const strong = motion({ peakAcceleration: 15 });
    expect(tick(strong).actions.Shake.pressed).toBe(false);
    expect(tick(motion({ peakAcceleration: 3 })).actions.Shake.pressed).toBe(false);
    expect(tick(strong).actions.Shake.pressed).toBe(false);
    const shaken = tick(strong);
    expect(shaken.actions.Shake).toMatchObject({ pressed: true, held: true });
    expect(tick(strong).actions.Shake).toMatchObject({ held: false, released: true });
    for (let i = 0; i < 10; i++) expect(tick(strong).actions.Shake.held).toBe(false);
    // 0.75 s after the shake, three more readings make another.
    for (let i = 0; i < 35; i++) tick();
    tick(strong);
    tick(strong);
    expect(tick(strong).actions.Shake.pressed).toBe(true);
  });

  it("does not shake on strong readings spread over more than half a second", () => {
    const { tick } = motionResolver();
    for (let reading = 0; reading < 3; reading++) {
      expect(tick(motion({ peakAcceleration: 20 })).actions.Shake.pressed).toBe(false);
      for (let i = 0; i < 20; i++) tick();
    }
  });
});
