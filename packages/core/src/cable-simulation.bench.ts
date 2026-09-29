import { bench, describe } from "vitest";
import { parseCableProperties } from "./cable-component";
import { CableSimulation } from "./cable-simulation";

const start = [0, 0, 0];
const end = [3, 0, 0];
const gravity = [0, -9.81, 0];
const COUNT = 300;
const activeProperties = parseCableProperties({ sleepThreshold: 0 });
const active = Array.from({ length: COUNT }, () => new CableSimulation(activeProperties, start, end));
const fourIterations = parseCableProperties({ sleepThreshold: 0, solverIterations: 4 });
const cheaper = Array.from({ length: COUNT }, () => new CableSimulation(fourIterations, start, end));
const brisk = Array.from({ length: COUNT }, () => new CableSimulation(activeProperties, start, end));
const sleepingProperties = parseCableProperties({ cableLength: 3, gravityScale: 0, sleepDelay: 0 });
const sleeping = Array.from({ length: COUNT }, () => new CableSimulation(sleepingProperties, start, end));
for (const cable of sleeping) cable.update(1 / 60, start, end, gravity);
const settledSlack = Array.from({ length: COUNT }, () => new CableSimulation(parseCableProperties({}), start, end));
for (const cable of settledSlack) for (let frame = 0; frame < 600 && !cable.sleeping; frame++) cable.update(1 / 60, start, end, gravity);
const interpolated = new Float32Array(active[0]!.positions.length);
let phase = 0;
let briskPhase = 0;

// Tethers run on every attached cable; each case includes them.
describe("300 cables, 16 segments, one 60 Hz step", () => {
  bench("active, 6 iterations, moving endpoint (collision off)", () => {
    end[1] = Math.sin(phase += 1 / 60) * .25;
    for (const cable of active) cable.update(1 / 60, start, end, gravity);
  }, { time: 1000, warmupTime: 250 });

  bench("active, 4 iterations, moving endpoint (collision off)", () => {
    end[1] = Math.sin(phase += 1 / 60) * .25;
    for (const cable of cheaper) cable.update(1 / 60, start, end, gravity);
  }, { time: 1000, warmupTime: 250 });

  const briskStart = [0, 0, 0];
  bench("active, 15 units/second pin (tether-bounded stretch)", () => {
    briskStart[0] = 5 * Math.sin(briskPhase += 3 / 60);
    for (const cable of brisk) cable.update(1 / 60, briskStart, end, gravity);
  }, { time: 1000, warmupTime: 250 });

  const fixedEnd = [3, 0, 0];
  bench("sleeping with fixed endpoints (collision off)", () => {
    for (const cable of sleeping) cable.update(1 / 60, start, fixedEnd, gravity);
  }, { time: 1000, warmupTime: 250 });

  // Play updates sleeping cables every tick. Idle editor cables skip `update`
  // entirely (stepEditorCables compares anchor world-matrix flags first).
  bench("sleeping slack cables updated at 144 Hz with unchanged anchors", () => {
    for (const cable of settledSlack) cable.update(1 / 144, start, fixedEnd, gravity);
  }, { time: 1000, warmupTime: 250 });

  bench("editor display: interpolated positions for awake cables", () => {
    for (const cable of active) cable.writeInterpolated(interpolated);
  }, { time: 1000, warmupTime: 250 });
});
