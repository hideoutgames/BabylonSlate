import { bench, describe } from "vitest";
import { parseCableProperties } from "./cable-component";
import { CableSimulation } from "./cable-simulation";

const start = [0, 0, 0];
const end = [3, 0, 0];
const gravity = [0, -9.81, 0];
const activeProperties = parseCableProperties({ sleepThreshold: 0 });
const active = Array.from({ length: 300 }, () => new CableSimulation(activeProperties, start, end));
const sleepingProperties = parseCableProperties({ cableLength: 3, gravityScale: 0, sleepDelay: 0 });
const sleeping = Array.from({ length: 300 }, () => new CableSimulation(sleepingProperties, start, end));
for (const cable of sleeping) cable.update(1 / 60, start, end, gravity);
let phase = 0;

describe("300 cables, 16 segments, 6 iterations, one 60 Hz step", () => {
  bench("active with moving endpoint (collision off)", () => {
    end[1] = Math.sin(phase += 1 / 60) * .25;
    for (const cable of active) cable.update(1 / 60, start, end, gravity);
  }, { time: 1000, warmupTime: 250 });

  const fixedEnd = [3, 0, 0];
  bench("sleeping with fixed endpoints (collision off)", () => {
    for (const cable of sleeping) cable.update(1 / 60, start, fixedEnd, gravity);
  }, { time: 1000, warmupTime: 250 });
});
