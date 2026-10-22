import { describe, expect, expectTypeOf, it } from "vitest";
import { createSeededRng } from "@babylonslate/core";
import { Actor, type TickContext } from "@babylonslate/object-model";
import {
  ScriptHost,
  type CompiledScript,
  type HostContextKey,
  type ScriptContext,
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

function tickWith(dt: number, tickIndex: number, held: boolean): TickContext {
  return { dt, tickIndex, world: { rngNextFloat: () => 0 }, isActionHeld: () => held };
}

const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

describe("ScriptContext members used apart from their context", () => {
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
    expect(random.float()).toBe(createSeededRng(42).nextFloat());
    expect(getAllActorsOfClass("Hero")).toEqual([hero]);
  });

  it("lets a script patch ctx.random or a ctx member without changing any other context", () => {
    const logged: string[] = [];
    const host = new ScriptHost(services({ seed: 7, log: (_severity, _category, message) => { logged.push(message); } }));
    const patched = host.createContext(null, 0, 0);
    patched.random.float = () => 0.99;
    patched.log = () => {};

    expect(patched.random.float()).toBe(0.99);
    patched.log("log", "Cat", "swallowed");
    const other = host.createContext(null, 0, 0);
    other.log("log", "Cat", "kept");

    expect(other.random.float()).toBe(createSeededRng(7).nextFloat());
    expect(logged).toEqual(["kept"]);
  });

  it("keeps per-call members bound to the context they came from", () => {
    const host = new ScriptHost(services());
    const a = new Actor({ classId: "Hero", guid: "a" });
    const b = new Actor({ classId: "Hero", guid: "b" });
    const { setVariable, getVariable } = host.createContext(a, 0.1, 1);
    const fromB = host.createContext(b, 0.2, 2);

    setVariable("hp", 3);
    fromB.setVariable("hp", 9);

    expect(getVariable("hp")).toBe(3);
    expect(a.getVariable("hp")).toBe(3);
    expect(b.getVariable("hp")).toBe(9);
  });

  it("gives each dispatch its own self, delta, tick index, input and arguments", async () => {
    const host = new ScriptHost(services());
    await host.load(script("Hero", [
      "export function onTick(ctx) {",
      "  ctx.self.setVariable('seen', [ctx.self.guid, ctx.deltaSeconds, ctx.tickIndex, ctx.getVariable('tag'), ctx.isActionHeld('Jump'), ctx.args]);",
      "}",
    ].join("\n"), { entryPoints: [{ name: "onTick", event: "onTick", isAsync: false }] }));
    const a = new Actor({ classId: "Hero", guid: "a" });
    const b = new Actor({ classId: "Hero", guid: "b" });
    a.setVariable("tag", "A");
    b.setVariable("tag", "B");
    const hooks = host.hooksFor("Hero")!;

    hooks.onTick!(a, tickWith(0.1, 1, true));
    hooks.onTick!(b, tickWith(0.2, 2, false));

    expect(a.getVariable("seen")).toEqual(["a", 0.1, 1, "A", true, {}]);
    expect(b.getVariable("seen")).toEqual(["b", 0.2, 2, "B", false, {}]);
  });
});

describe("ScriptContext shape", () => {
  // Scripts can enumerate a context (`Object.keys`, spread, `for in`), so the per-call members and their
  // order are part of what they observe. `createContext` assigns them one by one, so the compiler no longer
  // checks that it covers every member that is not inherited; the type check below does.
  const PER_CALL_KEYS = [
    "registerSaveMigration", "getSaveMigrationField", "setSaveMigrationField", "data", "readDataEntryAsync",
    "editorData", "self", "deltaSeconds", "tickIndex", "debugTrace", "commandArgs", "args", "animFacts", "animExitTimeReached",
    "flowState", "reportCommand", "random", "getVariable", "variableReference", "tweenValue", "tweenProperty",
    "setVariable", "getVariableFrom", "setVariableOn", "setMeshMaterialAsync", "setMaterialTextureParameterAsync",
    "destroyActor", "setActorLocation", "addActorWorldOffset", "setActorRotation", "setActorScale",
    "setActorTransform", "attachToBone", "executeConsoleCommandAsync", "delay", "callInterface", "getComponent",
    "getComponentById", "callComponentFunction", "addComponent", "spawnActor", "spawnActorAsync",
    "requestAssetLoad", "requestClassLoad", "waitForAssetLoad", "unloadAsset", "prepareAssets",
    "loadSceneBlocking", "unloadSceneBlocking", "getSceneReference", "invokeCustomEvent", "invokeEvent",
    "invokeFunction", "isActionHeld", "inputBindings", "getInputState", "wasActionPressed", "wasActionReleased",
    "getPressedKeys", "getAxis", "getAxis2D", "getCursorPosition", "getTouches", "getTouchEvents", "setCursorVisible",
    "setGamepadRumble", "gamepadConnections", "sampleWater", "lineTrace", "projectCursorToScene", "projectTouchToScene",
    "sphereOverlap", "shapeSweep",
    "addImpulse", "moveCharacter", "playSound", "playParticles", "stopParticles", "createSceneLayerAsync",
    "moveTo", "stopMovement", "btFinish", "btEvaluate", "getBlackboard", "setBlackboard",
  ] as const satisfies readonly (keyof ScriptContext)[];
  const perCallKeys: readonly string[] = PER_CALL_KEYS;

  it("owns the per-call members in a fixed order and inherits the host's shared members", () => {
    // Every ScriptContext member is either inherited from the host or listed above.
    expectTypeOf<Exclude<keyof ScriptContext, HostContextKey | (typeof PER_CALL_KEYS)[number]>>().toBeNever();
    const host = new ScriptHost(services());
    const first = host.createContext(null, 0, 0);
    const second = host.createContext(new Actor({ classId: "Hero", guid: "a" }), 0.1, 1, { x: 1 });

    expect(Object.keys(first)).toEqual(perCallKeys);
    expect(Object.keys(second)).toEqual(perCallKeys);

    const shared = Object.getPrototypeOf(first) as Record<string, unknown>;
    expect(Object.getPrototypeOf(second)).toBe(shared);
    expect(Object.getPrototypeOf(shared)).toBe(Object.prototype);
    const hostKeys = Object.keys(shared);
    expect(hostKeys).toEqual(expect.arrayContaining(["log", "print", "formatValue", "randomFloat", "isA"]));
    expect(hostKeys.filter((key) => perCallKeys.includes(key))).toEqual([]);
    for (const key of hostKeys) expect(first[key as keyof typeof first]).toBe(shared[key]);

    const otherHost = new ScriptHost(services()).createContext(null, 0, 0);
    expect(Object.getPrototypeOf(otherHost)).not.toBe(shared);
  });

  it("keeps a detached member that calls back through its context working after createContext returns", () => {
    const hero = new Actor({ classId: "Hero", guid: "hero" });
    const { variableReference } = new ScriptHost(services()).createContext(hero, 0, 0);

    variableReference(null, "hp", true)?.set(7);

    expect(hero.getVariable("hp")).toBe(7);
  });
});

describe("ScriptContext captured by a pending latent run", () => {
  it("keeps its own self, delta, tick index and input while other dispatches run, and skips its own re-entry", async () => {
    const gates: Array<() => void> = [];
    const host = new ScriptHost(services({ delay: () => new Promise<void>((resolve) => { gates.push(resolve); }) }));
    await host.load(script("Hero", [
      "export async function onTick(ctx) {",
      "  ctx.self.setVariable('runs', (ctx.self.getVariable('runs') ?? 0) + 1);",
      "  await ctx.delay(1);",
      "  ctx.self.setVariable('resumed', [ctx.self.guid, ctx.deltaSeconds, ctx.tickIndex, ctx.getVariable('tag'), ctx.isActionHeld('Jump')]);",
      "}",
    ].join("\n"), { entryPoints: [{ name: "onTick", event: "onTick", isAsync: true }] }));
    const a = new Actor({ classId: "Hero", guid: "a" });
    const b = new Actor({ classId: "Hero", guid: "b" });
    a.setVariable("tag", "A");
    b.setVariable("tag", "B");
    const hooks = host.hooksFor("Hero")!;

    hooks.onTick!(a, tickWith(0.1, 1, true));
    hooks.onTick!(b, tickWith(0.2, 2, false));
    hooks.onTick!(a, tickWith(0.3, 3, false));

    // Actor a's latent run is still pending, so its next tick starts nothing; b is independent.
    expect(gates).toHaveLength(2);
    expect(a.getVariable("runs")).toBe(1);
    expect(b.getVariable("runs")).toBe(1);

    for (const open of gates) open();
    await flush();

    expect(a.getVariable("resumed")).toEqual(["a", 0.1, 1, "A", true]);
    expect(b.getVariable("resumed")).toEqual(["b", 0.2, 2, "B", false]);

    hooks.onTick!(a, tickWith(0.4, 4, false));
    expect(a.getVariable("runs")).toBe(2);
    expect(gates).toHaveLength(3);
  });
});
