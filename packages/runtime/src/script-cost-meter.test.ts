import { describe, expect, it } from "vitest";
import { SCRIPT_COST_ENTRY_LIMIT, ScriptCostMeter } from "./script-cost-meter";
import type { CompiledScript } from "./script-host";

const door: CompiledScript = {
  assetGuid: "Door.class", classId: "Door", className: "Door", source: "", anchors: [],
  entryPoints: [
    { name: "onTick", event: "onTick", isAsync: false, nodeId: "tick", graphId: "event-graph", title: "Event Tick" },
    { name: "Open", isAsync: false, nodeId: "entry", graphId: "Open", title: "Open" },
  ],
};

function clocked() {
  let now = 0;
  const meter = new ScriptCostMeter(() => now);
  return { meter, at: (ms: number) => { now = ms; } };
}

const drain = (meter: ScriptCostMeter) => {
  const rows: Array<[entry: number, calls: number, ms: number]> = [];
  meter.drainTick((entry, calls, ms) => rows.push([entry, calls, ms]));
  return rows;
};

describe("ScriptCostMeter", () => {
  it("counts each call's own time, leaving out the entries it calls", () => {
    const { meter, at } = clocked();
    at(0); meter.enter(door, "onTick");
    at(1); meter.enter(door, "Open");
    at(4); meter.exit();
    at(5); meter.enter(door, "Open");
    at(6); meter.exit();
    at(10); meter.exit();
    expect(meter.takeNewEntries()).toEqual([
      { assetGuid: "Door.class", classId: "Door", className: "Door", exportName: "onTick", event: "onTick", title: "Event Tick", graphId: "event-graph", nodeId: "tick" },
      { assetGuid: "Door.class", classId: "Door", className: "Door", exportName: "Open", title: "Open", graphId: "Open", nodeId: "entry" },
    ]);
    // Open ran twice for 4 ms; Event Tick's 10 ms less those is its own 6.
    expect(drain(meter)).toEqual([[1, 2, 4], [0, 1, 6]]);
  });

  it("starts each tick empty and names an entry only once", () => {
    const { meter, at } = clocked();
    at(0); meter.enter(door, "onTick");
    at(2); meter.exit();
    expect(meter.ranCount).toBe(1);
    drain(meter);
    expect(meter.takeNewEntries()).toHaveLength(1);
    expect(meter.ranCount).toBe(0);
    expect(drain(meter)).toEqual([]);
    at(5); meter.enter(door, "onTick");
    at(6); meter.exit();
    expect(drain(meter)).toEqual([[0, 1, 1]]);
    expect(meter.takeNewEntries()).toEqual([]);
  });

  it("keeps one entry for a script reloaded while recording", () => {
    const { meter, at } = clocked();
    at(0); meter.enter(door, "onTick");
    at(1); meter.exit();
    at(2); meter.enter({ ...door, source: "// reloaded" }, "onTick");
    at(4); meter.exit();
    expect(meter.takeNewEntries()).toHaveLength(1);
    expect(drain(meter)).toEqual([[0, 2, 3]]);
  });

  it("leaves entries past its limit out of the rows, still keeping their time out of their caller's", () => {
    const { meter, at } = clocked();
    const many: CompiledScript = { ...door, entryPoints: [] };
    for (let index = 0; index < SCRIPT_COST_ENTRY_LIMIT; index++) { meter.enter(many, `f${index}`); meter.exit(); }
    drain(meter);
    at(0); meter.enter(door, "onTick");
    at(1); meter.enter(door, "Open");
    at(3); meter.exit();
    at(4); meter.exit();
    expect(meter.takeNewEntries()).toHaveLength(SCRIPT_COST_ENTRY_LIMIT);
    expect(drain(meter)).toEqual([]);
  });
});
