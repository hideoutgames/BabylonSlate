import { afterEach, describe, expect, it } from "vitest";
import { NullEngine, type Effect } from "@babylonjs/core";
import { DriverCompileWatch, pendingDriverCompiles } from "./driver-compile";
import { SCENE_DRIVER_COMPILE_TIMEOUT_MS } from "./stall-deadline";

function engineWith(parallel: boolean) {
  const engine = new NullEngine();
  if (parallel) engine.getCaps().parallelShaderCompile = { COMPLETION_STATUS_KHR: 0x91b1 };
  const effects = (engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects;
  const add = (key: string, state: { ready?: boolean; error?: string } = {}) => {
    const entry = { ready: false, error: "", ...state };
    effects[key] = { isReady: () => entry.ready, getCompilationError: () => entry.error } as unknown as Effect;
    return entry;
  };
  return { engine, add };
}

describe("driver compile watch", () => {
  const engines: NullEngine[] = [];
  afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });
  const setup = (parallel = true) => {
    const made = engineWith(parallel);
    engines.push(made.engine);
    return made;
  };

  it("lists only effects the driver is still compiling", () => {
    const { engine, add } = setup();
    add("ready", { ready: true });
    add("failed", { error: "link error" });
    add("compiling");
    expect(pendingDriverCompiles(engine)).toEqual(["compiling"]);
  });

  it("sees nothing pending without parallel shader compile", () => {
    const { engine, add } = setup(false);
    add("compiling");
    expect(pendingDriverCompiles(engine)).toEqual([]);
    expect(new DriverCompileWatch(engine).renew()).toBe(false);
  });

  it("renews while a cascade of compiles keeps changing the pending set", () => {
    const { engine, add } = setup();
    const watch = new DriverCompileWatch(engine);
    const step = SCENE_DRIVER_COMPILE_TIMEOUT_MS / 2;
    const first = add("first");
    expect(watch.renew(0)).toBe(true);
    first.ready = true;
    add("second");
    expect(watch.renew(step)).toBe(true);
    expect(watch.renew(step * 2 + 1)).toBe(true);
  });

  it("stops renewing when the same effects stay pending for the compile bound", () => {
    const { engine, add } = setup();
    const watch = new DriverCompileWatch(engine);
    add("hung");
    expect(watch.renew(0)).toBe(true);
    expect(watch.renew(SCENE_DRIVER_COMPILE_TIMEOUT_MS - 1)).toBe(true);
    expect(watch.renew(SCENE_DRIVER_COMPILE_TIMEOUT_MS)).toBe(false);
  });

  it("does not renew once nothing is pending", () => {
    const { engine, add } = setup();
    const watch = new DriverCompileWatch(engine);
    const effect = add("done");
    expect(watch.renew(0)).toBe(true);
    effect.ready = true;
    expect(watch.renew(1)).toBe(false);
  });
});
