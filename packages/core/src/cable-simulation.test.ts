import { describe, expect, it } from "vitest";
import { parseCableProperties } from "./cable-component";
import { CableSimulation, type CableCollision } from "./cable-simulation";

const START = [0, 0, 0] as const;
const END = [3, 0, 0] as const;
const GRAVITY = [0, -9.81, 0] as const;
const ZERO = [0, 0, 0] as const;
const STEP = 1 / 60;

describe("CableSimulation", () => {
  it("sags under gravity while keeping both pins fixed and each segment near its rest length", () => {
    const cable = new CableSimulation(parseCableProperties({ numSegments: 8, solverIterations: 16 }), START, END);
    for (let frame = 0; frame < 600; frame++) cable.update(STEP, START, END, GRAVITY);
    expect(Array.from(cable.positions.subarray(0, 3))).toEqual([0, 0, 0]);
    expect(Array.from(cable.positions.subarray(-3))).toEqual([3, 0, 0]);
    expect(cable.positions[13]).toBeLessThan(-0.5);
    for (let offset = 0; offset < cable.positions.length - 3; offset += 3) {
      const length = Math.hypot(
        cable.positions[offset + 3] - cable.positions[offset],
        cable.positions[offset + 4] - cable.positions[offset + 1],
        cable.positions[offset + 5] - cable.positions[offset + 2],
      );
      expect(length).toBeGreaterThan(0.47);
      expect(length).toBeLessThan(0.53);
    }
  });

  it("lets detached endpoints fall and keeps the same buffers through ordinary frames", () => {
    const cable = new CableSimulation(parseCableProperties({ cableLength: 3, attachStart: false, attachEnd: false, damping: 0 }), START, END);
    const positions = cable.positions;
    for (let frame = 0; frame < 60; frame++) cable.update(STEP, START, END, [0, -10, 0]);
    expect(cable.positions).toBe(positions);
    expect(cable.positions[1]).toBeCloseTo(-5.0833, 3);
    expect(cable.positions[cable.positions.length - 2]).toBeCloseTo(-5.0833, 3);
    expect(cable.positions[0]).toBe(0);
  });

  it("uses fixed steps regardless of frame subdivision and drops a long stall's backlog", () => {
    const properties = parseCableProperties({ cableLength: 3, attachStart: false, attachEnd: false, damping: 0 });
    const whole = new CableSimulation(properties, START, END);
    const halves = new CableSimulation(properties, START, END);
    for (let frame = 0; frame < 30; frame++) {
      whole.update(STEP, START, END, GRAVITY);
      halves.update(STEP / 2, START, END, GRAVITY);
      halves.update(STEP / 2, START, END, GRAVITY);
    }
    expect(halves.positions).toEqual(whole.positions);
    const stalled = new CableSimulation(properties, START, END);
    stalled.update(60, START, END, [0, -10, 0]);
    expect(stalled.positions[1]).toBeCloseTo(-1 / 36, 6); // Four fixed steps.
    expect(stalled.update(0, START, END, GRAVITY)).toBe(false);
    stalled.update(STEP, START, END, [0, -10, 0]);
    expect(stalled.positions[1]).toBeCloseTo(-1 / 24, 6); // One further step, no backlog.
    const before = stalled.positions.slice();
    for (const invalid of [NaN, Infinity, -1]) expect(stalled.update(invalid, START, END, GRAVITY)).toBe(false);
    expect(stalled.positions).toEqual(before);
  });

  it("sleeps settled cables and wakes immediately for attached anchors or gravity changes", () => {
    const cable = new CableSimulation(parseCableProperties({ cableLength: 3, sleepDelay: 0.05 }), START, END);
    for (let frame = 0; frame < 4; frame++) cable.update(STEP, START, END, ZERO);
    expect(cable.sleeping).toBe(true);
    expect(cable.update(STEP, START, END, ZERO)).toBe(false);
    expect(cable.update(0, [0, 1, 0], END, ZERO)).toBe(true);
    expect(cable.sleeping).toBe(false);
    expect(cable.positions[1]).toBe(1);
    cable.reset(START, END);
    for (let frame = 0; frame < 4; frame++) cable.update(STEP, START, END, ZERO);
    expect(cable.sleeping).toBe(true);
    expect(cable.update(STEP, START, END, GRAVITY)).toBe(true);
    expect(cable.sleeping).toBe(false);
    expect(cable.positions[4]).toBeLessThan(0);
  });

  it("ignores detached anchor motion and wakes for force/attachment changes without reallocating", () => {
    const properties = parseCableProperties({ cableLength: 3, attachStart: false, attachEnd: false, sleepDelay: 0 });
    const cable = new CableSimulation(properties, START, END);
    cable.update(STEP, START, END, ZERO);
    expect(cable.sleeping).toBe(true);
    expect(cable.update(STEP, [0, 3, 0], [3, 3, 0], ZERO)).toBe(false);
    const positions = cable.positions;
    cable.configure({ ...properties, cableForce: [0, 10, 0] });
    expect(cable.sleeping).toBe(false);
    cable.update(STEP, START, END, ZERO);
    expect(cable.positions).toBe(positions);
    expect(cable.positions[1]).toBeGreaterThan(0);
    cable.configure({ ...properties, attachStart: true, numSegments: 4 });
    expect(cable.positions.length).toBe(15);
    expect(Array.from(cable.positions.subarray(0, 3))).toEqual([0, 0, 0]);
  });

  it("collides only when enabled, resolves free particles, and keeps checking moving obstacles", () => {
    let calls = 0;
    let floor = 0.025;
    const collide: CableCollision = (previous, positions, particle, radius, friction) => {
      calls++;
      expect(particle).toBeGreaterThan(0);
      expect(particle).toBeLessThan(4);
      expect(radius).toBe(0.025);
      expect(friction).toBe(0.2);
      const y = particle * 3 + 1;
      if (positions[y] < floor) positions[y] = previous[y] = floor;
    };
    const properties = parseCableProperties({ cableLength: 3, numSegments: 4, sleepDelay: 0 });
    const cable = new CableSimulation(properties, START, END);
    cable.update(STEP, START, END, GRAVITY, collide);
    expect(calls).toBe(0);
    expect(cable.positions[4]).toBeLessThan(0);
    cable.configure({ ...properties, enableCollision: true });
    cable.update(STEP, START, END, GRAVITY, collide);
    expect(calls).toBe(3);
    expect(cable.positions[4]).toBeCloseTo(0.025, 6);
    floor = 1;
    cable.update(STEP, START, END, ZERO, collide);
    expect(cable.sleeping).toBe(false);
    expect(cable.positions[4]).toBe(1);
    expect(cable.positions[1]).toBe(0);
    expect(cable.positions[13]).toBe(0);
  });

  it("stays finite for coincident pins and an authored cable shorter than its pin separation", () => {
    for (const end of [START, [100, 0, 0]]) {
      const cable = new CableSimulation(parseCableProperties({ cableLength: 0.01, enableStiffness: true }), START, end);
      for (let frame = 0; frame < 120; frame++) cable.update(STEP, START, end, GRAVITY);
      expect(Array.from(cable.positions).every(Number.isFinite)).toBe(true);
      expect(Array.from(cable.positions.subarray(-3))).toEqual(end);
      expect(Math.max(...Array.from(cable.positions, Math.abs))).toBeLessThan(101);
    }
  });

  it("resets velocity and honors a disabled component", () => {
    const properties = parseCableProperties({ attachStart: false, attachEnd: false });
    const cable = new CableSimulation(properties, START, END);
    for (let frame = 0; frame < 30; frame++) cable.update(STEP, START, END, GRAVITY);
    cable.reset([0, 5, 0], [4, 5, 0]);
    cable.update(STEP, [0, 5, 0], [4, 5, 0], ZERO);
    expect(cable.positions[1]).toBe(5);
    cable.configure({ ...properties, enabled: false });
    const positions = cable.positions.slice();
    expect(cable.update(STEP, START, END, GRAVITY)).toBe(false);
    expect(cable.positions).toEqual(positions);
  });
});
