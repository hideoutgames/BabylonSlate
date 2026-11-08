import { describe, expect, it } from "vitest";
import { Actor, type EngineObject } from "@haptic/object-model";
import { EventDelegate } from "./script-dispatchers";
import { ScriptTimers, TIMER_MAX_FIRES_PER_STEP } from "./script-timers";

function timers(canRun: (owner: EngineObject) => boolean = () => true) {
  const fired: string[] = [];
  const system = new ScriptTimers({ canRunActions: canRun }, (delegate) => fired.push(delegate.name));
  return { system, fired };
}
const owner = () => new Actor({ classId: "Hero" });
const event = (object: EngineObject, name: string) => new EventDelegate(object, name, "event", []);

describe("Script timers", () => {
  it("fire once, or every interval while looping, with the start delay added to the first interval only", () => {
    const { system, fired } = timers();
    const hero = owner();
    const once = system.set(hero, event(hero, "Once"), 0.5, false);
    const loop = system.set(hero, event(hero, "Loop"), 0.5, true, 0.25);
    expect(system.set(hero, event(hero, "Never"), 0, true)).toBe(0);
    for (let step = 0; step < 8; step++) system.advance(0.25);
    // Once at 0.5; Loop at 0.75, 1.25 and 1.75.
    expect(fired).toEqual(["Once", "Loop", "Loop", "Loop"]);
    expect(system.exists(once)).toBe(false);
    expect([system.remaining(loop), system.elapsed(loop)]).toEqual([0.25, 0.25]);
    expect([system.remaining(once), system.elapsed(once)]).toEqual([-1, -1]);
  });

  it("hold while paused, end when cleared or when the owner or event object goes, and hold for an owner that may not run", () => {
    let running = true;
    const { system, fired } = timers(() => running);
    const hero = owner(), target = owner();
    const id = system.set(hero, event(target, "Ping"), 1, true);
    system.setPaused(id, true);
    system.advance(5);
    expect([fired, system.isActive(id), system.isPaused(id)]).toEqual([[], false, true]);
    system.setPaused(id, false);
    running = false;
    system.advance(5);
    expect(fired).toEqual([]);
    running = true;
    system.advance(1);
    expect(fired).toEqual(["Ping"]);
    target.destroyed = true;
    expect(system.exists(id)).toBe(false);
    const other = system.set(hero, event(hero, "Other"), 1, false);
    system.clear(other);
    system.advance(2);
    expect(fired).toEqual(["Ping"]);
  });

  it("count only owners that tick on pause while the game is paused, and cap catch-up fires per step", () => {
    const { system, fired } = timers();
    const awake = owner(), asleep = owner();
    system.set(awake, event(awake, "Awake"), 1, false);
    system.set(asleep, event(asleep, "Asleep"), 1, false);
    system.advance(1, (candidate) => candidate === awake);
    expect(fired).toEqual(["Awake"]);
    const fast = system.set(awake, event(awake, "Fast"), 0.001, true);
    system.advance(1);
    expect(fired.filter((name) => name === "Fast")).toHaveLength(TIMER_MAX_FIRES_PER_STEP);
    expect(system.isActive(fast)).toBe(true);
  });
});
