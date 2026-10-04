import { describe, expect, it } from "vitest";
import { parseCableProperties } from "./cable-component";
import { CableSimulation, type CableCollision } from "./cable-simulation";

const START = [0, 0, 0] as const;
const END = [3, 0, 0] as const;
const GRAVITY = [0, -9.81, 0] as const;
const ZERO = [0, 0, 0] as const;
const STEP = 1 / 60;

function totalLength(positions: ArrayLike<number>): number {
  let length = 0;
  for (let offset = 0; offset + 5 < positions.length; offset += 3) {
    length += Math.hypot(positions[offset + 3]! - positions[offset]!, positions[offset + 4]! - positions[offset + 1]!, positions[offset + 5]! - positions[offset + 2]!);
  }
  return length;
}

function interiorChanged(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  for (let index = 3; index < a.length - 3; index++) if (a[index] !== b[index]) return true;
  return false;
}

function maximumDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let distance = 0;
  for (let offset = 0; offset < a.length; offset += 3) {
    distance = Math.max(distance, Math.hypot(a[offset]! - b[offset]!, a[offset + 1]! - b[offset + 1]!, a[offset + 2]! - b[offset + 2]!));
  }
  return distance;
}

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
    // Editor viewports step collision-enabled cables without a callback; those settle and sleep.
    for (let frame = 0; frame < 600 && !cable.sleeping; frame++) cable.update(STEP, START, END, ZERO);
    expect(cable.sleeping).toBe(true);
    expect(cable.update(STEP, START, END, ZERO)).toBe(false);
  });

  it("starts and re-poses a colliding cable on thin geometry instead of sagging through it", () => {
    // A one-sided floor plane, like a heightfield: only particles arriving from above are stopped.
    const floor = -1;
    const collide: CableCollision = (previous, positions, particle, radius) => {
      const y = particle * 3 + 1, top = floor + radius;
      if (previous[y]! > floor && positions[y]! < top) positions[y] = previous[y] = top;
    };
    // Level pins 1 unit above the floor; the free catenary would sag 1.18 below them.
    const cable = new CableSimulation(parseCableProperties({ enableCollision: true }), START, END);
    const lowest = () => {
      let y = Infinity;
      for (let offset = 1; offset < cable.positions.length; offset += 3) y = Math.min(y, cable.positions[offset]!);
      return y;
    };
    let worst = Infinity;
    for (let frame = 0; frame < 120; frame++) {
      cable.update(STEP, START, END, GRAVITY, collide);
      worst = Math.min(worst, lowest());
    }
    expect(worst).toBeGreaterThan(floor);
    // A teleport re-poses onto the floor at the destination too.
    const start = [40, 0, 0], end = [43, 0, 0];
    for (let frame = 0; frame < 60; frame++) {
      cable.update(STEP, start, end, GRAVITY, collide);
      worst = Math.min(worst, lowest());
    }
    expect(worst).toBeGreaterThan(floor);
    expect(cable.positions[8 * 3]).toBeCloseTo(41.5, 1);
  });

  it("keeps a fast-carried cable swinging but still re-poses a jump during that motion", () => {
    // Both pins ride one actor moving sideways at 90 units/second: 1.5 units per
    // frame, beyond the 1-unit jump distance of this 2-unit cable.
    const cable = new CableSimulation(parseCableProperties({ cableLength: 2, endPosition: [1.5, 0, 0] }), START, [1.5, 0, 0]);
    for (let frame = 0; frame < 300; frame++) cable.update(STEP, START, [1.5, 0, 0], GRAVITY);
    let z = 0;
    for (let frame = 0; frame < 20; frame++) {
      z += 1.5;
      cable.update(STEP, [0, 0, z], [1.5, 0, z], GRAVITY);
    }
    // The carried cable trails its pins; one re-posed every frame would hang level with them.
    expect(cable.positions[8 * 3 + 2]).toBeLessThan(z - 0.1);
    let ahead = -Infinity;
    for (let frame = 0; frame < 60; frame++) {
      cable.update(STEP, [0, 0, z], [1.5, 0, z], GRAVITY);
      ahead = Math.max(ahead, cable.positions[8 * 3 + 2]! - z);
    }
    // Stopping swings it forward past the pins.
    expect(ahead).toBeGreaterThan(0.1);
    // Moving again at the same pace, then jumping 50 units in one frame, re-poses at the destination.
    for (let frame = 0; frame < 5; frame++) {
      z += 1.5;
      cable.update(STEP, [0, 0, z], [1.5, 0, z], GRAVITY);
    }
    z += 50;
    cable.update(STEP, [0, 0, z], [1.5, 0, z], GRAVITY);
    expect(totalLength(cable.positions)).toBeLessThan(2.1);
    expect(cable.positions[8 * 3 + 2]).toBeCloseTo(z, 1);
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

  it("starts a slack cable at its catenary rest shape and sleeps within two seconds", () => {
    const cable = new CableSimulation(parseCableProperties({}), START, END);
    cable.update(0, START, END, GRAVITY);
    // Level pins 3 apart with 4 units of cable: catenary sag 1.1773 at the midpoint.
    expect(cable.positions[8 * 3 + 1]).toBeCloseTo(-1.1773, 3);
    expect(cable.positions[8 * 3]).toBeCloseTo(1.5, 5);
    const initial = cable.positions.slice();
    let frames = 0;
    while (!cable.sleeping && frames < 600) { cable.update(STEP, START, END, GRAVITY); frames++; }
    expect(frames).toBeLessThanOrEqual(120);
    expect(maximumDistance(initial, cable.positions)).toBeLessThan(0.1);
  });

  it("bounds total stretch while an attached pin moves briskly", () => {
    const properties = parseCableProperties({});
    const cable = new CableSimulation(properties, START, END);
    let worst = 0;
    for (let frame = 0; frame < 600; frame++) {
      // Peak pin speed 15 units/second; stretching to a wider pin separation is allowed.
      const start = [5 * Math.sin(3 * frame * STEP), 0, 0];
      cable.update(STEP, start, END, GRAVITY);
      worst = Math.max(worst, totalLength(cable.positions) / Math.max(properties.cableLength, Math.abs(END[0] - start[0]!)));
    }
    expect(worst).toBeLessThan(1.04);
  });

  it("folds slack between vertically aligned pins instead of compressing a rod", () => {
    const end = [0, -2, 0];
    const cable = new CableSimulation(parseCableProperties({}), START, end);
    for (let frame = 0; frame < 300; frame++) cable.update(STEP, START, end, GRAVITY);
    let lowest = 0;
    for (let offset = 0; offset + 5 < cable.positions.length; offset += 3) {
      const segment = Math.hypot(cable.positions[offset + 3]! - cable.positions[offset]!, cable.positions[offset + 4]! - cable.positions[offset + 1]!, cable.positions[offset + 5]! - cable.positions[offset + 2]!);
      expect(segment).toBeGreaterThan(0.2375);
      expect(segment).toBeLessThan(0.2625);
      lowest = Math.min(lowest, cable.positions[offset + 1]!);
    }
    // Hanging 3 units below the upper pin uses the full length: 3 down plus 1 back up.
    expect(lowest).toBeCloseTo(-3, 1);
  });

  it("hangs a cable from its only attached end along the acceleration", () => {
    const hanging = new CableSimulation(parseCableProperties({ attachEnd: false }), START, END);
    hanging.update(0, START, END, GRAVITY);
    for (const particle of [1, 8, 16]) {
      expect(hanging.positions[particle * 3]).toBeCloseTo(0, 6);
      expect(hanging.positions[particle * 3 + 1]).toBeCloseTo(-0.25 * particle, 5);
    }
    const pulled = new CableSimulation(parseCableProperties({ attachStart: false, gravityScale: 0, cableForce: [0, 0, 5] }), START, END);
    pulled.update(0, START, END, GRAVITY);
    expect(Array.from(pulled.positions.subarray(-3))).toEqual([3, 0, 0]);
    expect(Array.from(pulled.positions.subarray(0, 3)).map((value) => Number(value.toFixed(5)))).toEqual([3, 0, 4]);
  });

  it("re-poses a teleported cable without a stretch spike but tracks ordinary pin motion", () => {
    const cable = new CableSimulation(parseCableProperties({}), START, END);
    for (let frame = 0; frame < 300; frame++) cable.update(STEP, START, END, GRAVITY);
    const settled = cable.positions.slice();
    const shifted = [50, 0, 0], shiftedEnd = [53, 0, 0];
    let longest = 0;
    for (let frame = 0; frame < 60; frame++) {
      cable.update(STEP, shifted, shiftedEnd, GRAVITY);
      longest = Math.max(longest, totalLength(cable.positions));
    }
    expect(longest).toBeLessThan(4.1);
    expect(cable.positions[8 * 3]).toBeCloseTo(settled[8 * 3]! + 50, 1);
    expect(cable.positions[8 * 3 + 1]).toBeCloseTo(settled[8 * 3 + 1]!, 1);
    // A short move pins the end without re-posing the rest of the cable.
    const before = cable.positions.slice();
    cable.update(0, [50.3, 0, 0], shiftedEnd, GRAVITY);
    expect(cable.positions[0]).toBeCloseTo(50.3, 5);
    expect(Array.from(cable.positions.subarray(3, -3))).toEqual(Array.from(before.subarray(3, -3)));
  });

  it("carries a cable with a discrete pin edit and settles without whipping", () => {
    const peakAfter = (edit: (cable: CableSimulation, start: number[]) => void, start: number[]) => {
      const cable = new CableSimulation(parseCableProperties({}), START, END);
      for (let frame = 0; frame < 300; frame++) cable.update(STEP, START, END, GRAVITY);
      edit(cable, start);
      expect(cable.positions[0]).toBeCloseTo(start[0]!, 5);
      expect(cable.positions[1]).toBeCloseTo(start[1]!, 5);
      let peak = -Infinity, longest = 0;
      for (let frame = 0; frame < 600; frame++) {
        cable.update(STEP, start, END, GRAVITY);
        peak = Math.max(peak, cable.positions[8 * 3 + 1]!);
        longest = Math.max(longest, totalLength(cable.positions));
      }
      expect(cable.sleeping).toBe(true);
      return { peak, longest };
    };
    // Raising the start pin by 1 (a typed Location): the midpoint stays below
    // the lower pin. Feeding the same jump as motion flings it far above both.
    const raised = [0, 1, 0];
    const carried = peakAfter((cable, start) => cable.carry(start, END), raised);
    expect(carried.peak).toBeLessThan(0);
    expect(carried.longest).toBeLessThan(4.1);
    expect(peakAfter((cable, start) => cable.update(0, start, END, GRAVITY), raised).peak).toBeGreaterThan(1);
    // Pulled exactly taut, the carried cable straightens without overshooting the pins.
    expect(peakAfter((cable, start) => cable.carry(start, END), [-1, 0, 0]).peak).toBeLessThan(0.05);
  });

  it("responds on the frame a sleeping cable's pin moves, even below one substep", () => {
    const cable = new CableSimulation(parseCableProperties({}), START, END);
    for (let frame = 0; frame < 600 && !cable.sleeping; frame++) cable.update(STEP, START, END, GRAVITY);
    expect(cable.sleeping).toBe(true);
    const before = cable.positions.slice();
    cable.update(1 / 144, [0, 0.2, 0], END, GRAVITY);
    expect(cable.sleeping).toBe(false);
    expect(cable.positions[4]).not.toBe(before[4]); // First free particle follows the pin.
  });

  it("interpolates between substeps for faster displays while keeping pins exact", () => {
    const cable = new CableSimulation(parseCableProperties({ sleepThreshold: 0 }), START, END);
    const out = new Float32Array(cable.positions.length);
    const previous = new Float32Array(out.length);
    let stepBefore = cable.positions.slice(), stepAfter = cable.positions.slice();
    let steppedFrames = 0, changedFrames = 0;
    for (let frame = 0; frame < 144; frame++) {
      const start = [0, Math.sin(frame / 20) * 0.5, 0];
      const positions = cable.positions.slice();
      cable.update(1 / 144, start, END, GRAVITY);
      if (interiorChanged(cable.positions, positions)) {
        steppedFrames++;
        stepBefore = positions;
        stepAfter = cable.positions.slice();
      }
      cable.writeInterpolated(out);
      expect(out[1]).toBe(Math.fround(start[1]!));
      expect(Array.from(out.subarray(-3))).toEqual([3, 0, 0]);
      for (let index = 3; index < out.length - 3; index++) {
        const low = Math.min(stepBefore[index]!, stepAfter[index]!), high = Math.max(stepBefore[index]!, stepAfter[index]!);
        expect(out[index]).toBeGreaterThanOrEqual(low - 1e-6);
        expect(out[index]).toBeLessThanOrEqual(high + 1e-6);
      }
      if (frame >= 4 && interiorChanged(out, previous)) changedFrames++;
      previous.set(out);
    }
    // Substeps advance on about 60 of 144 frames; once swinging, the displayed shape moves every frame.
    expect(steppedFrames).toBeLessThan(70);
    expect(changedFrames).toBe(140);
  });
});
