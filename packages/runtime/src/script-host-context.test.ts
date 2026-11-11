import { describe, expect, it } from "vitest";
import { RandomStream } from "@haptic/core";
import { Actor, type TickContext } from "@haptic/object-model";
import {
  ScriptHost,
  type CompiledScript,
  type ScriptHostServices,
} from "./script-host";

function services(extras: Partial<ScriptHostServices> = {}): ScriptHostServices {
  return {
    log: () => {},
    print: () => {},
    destroyActor: () => {},
    executeConsoleCommand: () => ({ success: true, output: "" }),
    delay: async () => {},
    reportError: () => {},
    ...extras,
  };
}

function script(classId: string, source: string, extra: Partial<CompiledScript> = {}): CompiledScript {
  return { assetGuid: `${classId}-asset`, classId, source, anchors: [], entryPoints: [], ...extra };
}

function tickWith(dt: number, tickIndex: number): TickContext {
  return { dt, tickIndex, world: { rngNextFloat: () => 0 } };
}

const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

describe("ScriptContext members", () => {
  it("keeps host members working when destructured and called without a receiver", () => {
    const logged: unknown[][] = [];
    const hero = new Actor({ classId: "Hero", guid: "hero" });
    const ctx = new ScriptHost(services({
      seed: 42,
      log: (...args) => { logged.push(args); },
      getActors: () => [hero, new Actor({ classId: "Rock", guid: "rock" })],
    })).createContext(null, 0, 0);

    const { log, random, formatValue, getAllActorsOfClass } = ctx;
    log("warning", "Cat", "hello");
    log("log", "Cat", formatValue(3));

    expect(logged).toEqual([["warning", "Cat", "hello"], ["log", "Cat", "3"]]);
    expect(random.float()).toBe(new RandomStream("42").nextFloat());
    expect(getAllActorsOfClass("Hero")).toEqual([hero]);
  });

  it("draws Random In Range values from the seeded session generator, in call order", () => {
    const draws = (seed: number) => {
      const host = new ScriptHost(services({ seed }));
      const a = host.createContext(null, 0, 0);
      const b = host.createContext(null, 0, 0);
      return [a.randomInRange("int", { Min: 1, Max: 6 }), a.random.float(), b.randomInRange("float", { Min: 10, Max: 20 })];
    };
    const rng = new RandomStream("11");
    const expected = [1 + (rng.next() % 6), rng.nextFloat(), 10 + 10 * rng.nextFloat()];
    expect(draws(11)).toEqual(expected);
    expect(draws(11)).toEqual(draws(11));
    expect(draws(12)).not.toEqual(expected);
  });

  it("gives one read-only Curve Object per loaded curve asset and None for missing or other kinds", () => {
    const key = (Time: number, Value: number) => ({ Time, Value, Interpolation: "linear", ArriveTangent: 0, LeaveTangent: 0 });
    const entry = (keys: unknown[]) => ({
      guid: "falloff", type: "FloatCurve" as const, name: "Falloff",
      payload: { curve: { Keys: keys, Before: "constant" as const, After: "constant" as const } },
    });
    const curves = new Map([["falloff", entry([key(0, 100), key(2, 50)])]]) as Map<string, ReturnType<typeof entry>>;
    const ctx = new ScriptHost(services({ curves } as Partial<ScriptHostServices>)).createContext(null, 0, 0);

    const object = ctx.getCurveObject("float", "falloff");
    expect(object?.classId).toBe("FloatCurveObject");
    expect(ctx.getCurveObject("float", "falloff")).toBe(object);
    expect(ctx.getCurveObject("vec3", "falloff")).toBeNull();
    expect(ctx.getCurveObject("float", "not-loaded")).toBeNull();
    expect(ctx.curveObjectValue("float", object, 1)).toBe(75);
    expect(ctx.curveObjectKeyCount(object)).toBe(2);
    expect(ctx.curveObjectTimeRange(object)).toEqual({ Min: 0, Max: 2 });
    expect(ctx.curveObjectValueRange(object)).toEqual({ Min: 50, Max: 100 });
    // Get Float Curve returns a copy: changing it leaves the asset's object alone.
    const copy = ctx.curveObjectCurve("float", object) as { Keys: Array<{ Value: number }> };
    copy.Keys[0]!.Value = -1;
    expect(ctx.curveObjectValue("float", object, 0)).toBe(100);
    expect(ctx.curveObjectValue("float", null, 1)).toBe(0);

    // A reloaded payload updates the same object, so stored references stay valid.
    curves.set("falloff", entry([key(0, 10), key(2, 30)]));
    expect(ctx.getCurveObject("float", "falloff")).toBe(object);
    expect(ctx.curveObjectValue("float", object, 1)).toBe(20);
  });

  it("acts on the object of the context a per-call member is called on", () => {
    const host = new ScriptHost(services());
    const a = new Actor({ classId: "Hero", guid: "a" });
    const b = new Actor({ classId: "Hero", guid: "b" });
    const fromA = host.createContext(a, 0.1, 1);
    const fromB = host.createContext(b, 0.2, 2);

    fromA.setVariable("hp", 3);
    fromB.setVariable("hp", 9);

    expect(fromA.getVariable("hp")).toBe(3);
    expect(fromB.getVariable("hp")).toBe(9);
    expect(a.getVariable("hp")).toBe(3);
    expect(b.getVariable("hp")).toBe(9);
  });

  it("gives each dispatch its own self, delta, tick index and arguments", async () => {
    const host = new ScriptHost(services());
    await host.load(script("Hero", [
      "export function onTick(ctx) {",
      "  ctx.self.setVariable('seen', [ctx.self.guid, ctx.deltaSeconds, ctx.tickIndex, ctx.getVariable('tag'), ctx.args]);",
      "}",
    ].join("\n"), { entryPoints: [{ name: "onTick", event: "onTick", isAsync: false }] }));
    const a = new Actor({ classId: "Hero", guid: "a" });
    const b = new Actor({ classId: "Hero", guid: "b" });
    a.setVariable("tag", "A");
    b.setVariable("tag", "B");
    const hooks = host.hooksFor("Hero")!;

    hooks.onTick!(a, tickWith(0.1, 1));
    hooks.onTick!(b, tickWith(0.2, 2));

    expect(a.getVariable("seen")).toEqual(["a", 0.1, 1, "A", {}]);
    expect(b.getVariable("seen")).toEqual(["b", 0.2, 2, "B", {}]);
  });
});

describe("ScriptContext input", () => {
  it("reads the host's input from a call no tick dispatched", async () => {
    const rumbles: number[][] = [];
    const host = new ScriptHost(services({
      input: {
        getCursorPosition: () => ({ x: 80, y: 24, pressed: true }),
        getTouches: () => [],
        setGamepadRumble: (...args) => { rumbles.push(args); },
      },
    }));
    await host.load(script("Hero", [
      "export function begin(ctx) {",
      "  const cursor = ctx.getCursorPosition();",
      "  ctx.self.setVariable('cursor', [cursor.x, cursor.y]);",
      "  ctx.setGamepadRumble(0, 0.5, 100);",
      "}",
    ].join("\n"), { entryPoints: [{ name: "begin", event: "onBeginPlay", isAsync: false }] }));
    const hero = new Actor({ classId: "Hero", guid: "hero" });

    host.hooksFor("Hero")!.onCreation!(hero);

    expect(hero.getVariable("cursor")).toEqual([80, 24]);
    expect(rumbles).toEqual([[0, 0.5, 100]]);
  });
});

describe("ScriptContext shape", () => {
  it("builds a context without creating a function for it", () => {
    const host = new ScriptHost(services());
    const first = host.createContext(null, 0, 0) as unknown as Record<string, unknown>;
    const second = host.createContext(new Actor({ classId: "Hero", guid: "a" }), 0.1, 1, { x: 1 }) as unknown as Record<string, unknown>;

    // Every script call builds a context, so a member made per context is made per call: each function a
    // context offers, its own or inherited, must be the one every other context of the host offers.
    const functions: string[] = [];
    for (const key in first) {
      if (typeof first[key] !== "function") continue;
      functions.push(key);
      expect(second[key], key).toBe(first[key]);
    }
    expect(functions).toEqual(expect.arrayContaining(["getVariable", "setVariable", "spawnActor", "invokeFunction", "getCursorPosition", "log", "print"]));
    expect(second.random).toBe(first.random);
  });

  it("shares one set of members between a host's contexts, and none with another host", () => {
    const host = new ScriptHost(services());
    const first = host.createContext(null, 0, 0);
    const second = host.createContext(new Actor({ classId: "Hero", guid: "a" }), 0.1, 1);
    expect(Object.getPrototypeOf(second)).toBe(Object.getPrototypeOf(first));

    const other = new ScriptHost(services()).createContext(null, 0, 0);
    expect(Object.getPrototypeOf(other)).not.toBe(Object.getPrototypeOf(first));
    expect(other.getVariable).not.toBe(first.getVariable);
    expect(other.log).not.toBe(first.log);
  });

  it("keeps a variable reference writing through its context after the call that made it", () => {
    const hero = new Actor({ classId: "Hero", guid: "hero" });
    const reference = new ScriptHost(services()).createContext(hero, 0, 0).variableReference(null, "hp", true);

    reference?.set(7);

    expect(hero.getVariable("hp")).toBe(7);
    expect(reference?.get?.()).toBe(7);
  });
});

describe("ScriptContext captured by a pending latent run", () => {
  it("keeps its own self, delta and tick index while other dispatches run, including its own re-entry", async () => {
    const gates: Array<() => void> = [];
    const host = new ScriptHost(services({ delay: () => new Promise<void>((resolve) => { gates.push(resolve); }) }));
    await host.load(script("Hero", [
      "export async function onTick(ctx) {",
      "  ctx.self.setVariable('runs', (ctx.self.getVariable('runs') ?? 0) + 1);",
      "  await ctx.delay(1);",
      "  const resumed = [ctx.self.guid, ctx.deltaSeconds, ctx.tickIndex, ctx.getVariable('tag')];",
      "  ctx.self.setVariable('resumed', [...(ctx.self.getVariable('resumed') ?? []), resumed]);",
      "}",
    ].join("\n"), { entryPoints: [{ name: "onTick", event: "onTick", isAsync: true }] }));
    const a = new Actor({ classId: "Hero", guid: "a" });
    const b = new Actor({ classId: "Hero", guid: "b" });
    a.setVariable("tag", "A");
    b.setVariable("tag", "B");
    const hooks = host.hooksFor("Hero")!;

    hooks.onTick!(a, tickWith(0.1, 1));
    hooks.onTick!(b, tickWith(0.2, 2));
    hooks.onTick!(a, tickWith(0.3, 3));

    // Actor a's second tick starts its own run while the first still waits.
    expect(gates).toHaveLength(3);
    expect(a.getVariable("runs")).toBe(2);
    expect(b.getVariable("runs")).toBe(1);

    for (const open of gates) open();
    await flush();

    expect(a.getVariable("resumed")).toEqual([["a", 0.1, 1, "A"], ["a", 0.3, 3, "A"]]);
    expect(b.getVariable("resumed")).toEqual([["b", 0.2, 2, "B"]]);
  });
});
