import { describe, expect, it } from "vitest";
import type { ActorDefaults } from "@haptic/core";
import type { Actor } from "@haptic/object-model";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";

function ticker(classId: string, parentClassId: string, actorDefaults?: ActorDefaults): CompiledScript {
  return {
    assetGuid: classId.toLowerCase(), classId, parentClassId, anchors: [],
    entryPoints: [{ name: "onTick", event: "onTick", isAsync: false }],
    source: `export function onTick(ctx) { ctx.self.setVariable("ticks", (ctx.self.getVariable("ticks") ?? 0) + 1); }`,
    ...(actorDefaults ? { actorDefaults } : {}),
  };
}

describe("Actor Defaults", () => {
  it("skips Event Tick when it resolves to Disabled along the Class chain", async () => {
    const runtime = createInProcessRuntime({ seed: 1, preferSoftwarePhysics: true });
    try {
      await runtime.loadScripts([
        ticker("Base", "Actor", { eventTick: "disabled", generateHitEvents: false }),
        ticker("Inheriting", "Base", { eventTick: "inherit" }),
        ticker("Reenabled", "Base", { eventTick: "enabled", generateHitEvents: true }),
        ticker("Plain", "Actor"),
      ]);
      runtime.start();
      const spawn = (classId: string) => runtime.spawnScriptedActor({ classId })!;
      const [base, inheriting, reenabled, plain] = ["Base", "Inheriting", "Reenabled", "Plain"].map(spawn);
      runtime.tick();
      runtime.tick();
      expect(base!.getVariable("ticks")).toBeUndefined();
      expect(inheriting!.getVariable("ticks")).toBeUndefined();
      expect(inheriting!.generateHitEvents).toBe(false);
      expect(reenabled!.getVariable("ticks")).toBe(2);
      expect(reenabled!.generateHitEvents).toBe(true);
      expect(plain!.getVariable("ticks")).toBe(2);
    } finally {
      runtime.stop();
    }
  });
});

/** Each Event Tick appends [tick index, Event Tick Delta Seconds, Get Delta Seconds] to the actor's `log`. */
function intervalTicker(classId: string, actorDefaults?: ActorDefaults, input?: string): CompiledScript {
  return {
    assetGuid: classId.toLowerCase(), classId, parentClassId: "Actor", anchors: [],
    entryPoints: [
      { name: "onTick", event: "onTick", isAsync: false },
      ...(input ? [{ name: "onInput", event: "onInput", isAsync: false }] : []),
    ],
    source: `export function onTick(ctx) {
        const log = ctx.self.getVariable("log") ?? [];
        log.push([ctx.tickIndex, ctx.deltaSeconds, ctx.getDeltaSeconds()]);
        ctx.self.setVariable("log", log);
      }
      ${input ?? ""}`,
    ...(actorDefaults ? { actorDefaults } : {}),
  };
}

type TickLog = Array<[number, number, number]>;
const logOf = (actor: Actor): TickLog => (actor.getVariable("log") as TickLog | undefined) ?? [];
const tickIndices = (actor: Actor) => logOf(actor).map(([tickIndex]) => tickIndex);

/** A fixed step of 0.25 s keeps every sum exact; a Tick Interval of 1 s is then 4 steps. */
const STEP = 0.25;

async function intervalRuntime(scripts: CompiledScript[]) {
  const runtime = createInProcessRuntime({ seed: 1, preferSoftwarePhysics: true, dt: STEP });
  await runtime.loadScripts(scripts);
  runtime.start();
  return runtime;
}

/** Eight actors of one Class with a 4-step interval, ticked 8 steps, then two of them destroyed and 8 more. */
async function staggerScenario() {
  const runtime = await intervalRuntime([intervalTicker("Crowd", { tickInterval: 1 })]);
  try {
    const actors = Array.from({ length: 8 }, () => runtime.spawnScriptedActor({ classId: "Crowd" })!);
    for (let step = 0; step < 8; step++) runtime.tick();
    // Destruction clears an actor's variables, so its log is kept from here.
    const before = actors.map(actor => [...logOf(actor)]);
    runtime.getWorld().destroyActor(actors[0]!.guid);
    runtime.getWorld().destroyActor(actors[5]!.guid);
    for (let step = 0; step < 8; step++) runtime.tick();
    return { before, logs: actors.map((actor, index) => actor.destroyed ? before[index]! : logOf(actor)) };
  } finally {
    runtime.stop();
  }
}

describe("Actor Defaults Tick Interval", () => {
  it("spreads one Class's actors evenly over the steps and keeps each one's phase when others are destroyed", async () => {
    const { before, logs } = await staggerScenario();
    const ticks = (log: TickLog) => log.map(([tickIndex]) => tickIndex);
    const perStep = new Map<number, number>();
    for (const log of before) for (const tickIndex of ticks(log)) perStep.set(tickIndex, (perStep.get(tickIndex) ?? 0) + 1);
    // Eight actors ticking every fourth step: two on each step, never all on one.
    expect([...perStep].sort(([a], [b]) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map(tickIndex => [tickIndex, 2]));
    // Spawn orders 1 and 2 tick on steps 3, 7, 11, 15 and 2, 6, 10, 14, before and after the destroys.
    expect(ticks(logs[1]!)).toEqual([3, 7, 11, 15]);
    expect(ticks(logs[2]!)).toEqual([2, 6, 10, 14]);
    // Each tick but the first covers the whole interval; the first covers the steps since the actor's first.
    expect(logs[1]!.map(([, delta]) => delta)).toEqual([1, 1, 1, 1]);
    expect(logs[2]![0]).toEqual([2, 0.75, 0.75]);
    expect(ticks(logs[0]!)).toEqual([0, 4]);
  });

  it("repeats the same ticks and deltas in two runs of one scenario", async () => {
    const first = await staggerScenario();
    const second = await staggerScenario();
    expect(second.logs).toEqual(first.logs);
    // Eight actors twice in the first 8 steps, the six survivors twice in the next 8.
    expect(first.logs.flat()).toHaveLength(28);
  });

  it("passes the simulation time since the last Event Tick, across a time dilation change and a game pause", async () => {
    const runtime = await intervalRuntime([intervalTicker("Slow", { tickInterval: 1 }), intervalTicker("Fast")]);
    try {
      // Spawned first, so its phase puts its Event Ticks on steps 0, 4 and 8.
      const slow = runtime.spawnScriptedActor({ classId: "Slow" })!;
      const fast = runtime.spawnScriptedActor({ classId: "Fast" })!;
      runtime.tick(); runtime.tick(); runtime.tick();
      runtime.setTimeDilation(0.5);
      runtime.tick(); runtime.tick();
      runtime.setGamePaused(true);
      runtime.tick(); runtime.tick();
      runtime.setGamePaused(false);
      runtime.tick(); runtime.tick();
      // Step 0 is its first, so one step, as an unthrottled actor's first tick. Step 4 covers three full steps and
      // two dilated ones; step 8 the two dilated steps after the pause, which added nothing.
      expect(logOf(slow)).toEqual([[0, 0.25, 0.25], [4, 0.75, 0.75], [8, 0.25, 0.25]]);
      // The unthrottled actor in the same world still reads one step, from Get Delta Seconds too.
      expect(logOf(fast)).toEqual([
        [0, 0.25, 0.25], [1, 0.25, 0.25], [2, 0.25, 0.25], [3, 0.125, 0.125], [4, 0.125, 0.125], [7, 0.125, 0.125], [8, 0.125, 0.125],
      ]);
    } finally {
      runtime.stop();
    }
  });

  it("dispatches input every step while Event Tick waits for its interval", async () => {
    const input = `export function onInput(ctx) {
        const keys = ctx.self.getVariable("keys") ?? [];
        keys.push(ctx.tickIndex + ":" + ctx.getPressedKeys().join(","));
        ctx.self.setVariable("keys", keys);
      }`;
    const runtime = await intervalRuntime([intervalTicker("Pilot", { tickInterval: 1 }, input)]);
    try {
      const pilot = runtime.spawnScriptedActor({ classId: "Pilot" })!;
      runtime.tick();
      runtime.pushInput([{ kind: "key", tick: 1, code: "Space", phase: "down" }]);
      runtime.tick();
      runtime.pushInput([{ kind: "key", tick: 2, code: "Space", phase: "up" }]);
      runtime.tick(); runtime.tick(); runtime.tick();
      expect(tickIndices(pilot)).toEqual([0, 4]);
      // The press and the release both land between its Event Ticks, each seen on the step it happens.
      expect(pilot.getVariable("keys")).toEqual(["0:", "1:Space", "2:", "3:", "4:"]);
    } finally {
      runtime.stop();
    }
  });

  it("ticks every step for an interval shorter than one step and rounds others to the nearest step", async () => {
    const runtime = await intervalRuntime([
      intervalTicker("Short", { tickInterval: 0.1 }),
      intervalTicker("Under", { tickInterval: 0.6 }),
      intervalTicker("Over", { tickInterval: 0.65 }),
    ]);
    try {
      const [short, under, over] = ["Short", "Under", "Over"].map(classId => runtime.spawnScriptedActor({ classId })!);
      for (let step = 0; step < 7; step++) runtime.tick();
      expect(tickIndices(short!)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      // 0.6 s is 2.4 steps, so 2; 0.65 s is 2.6 steps, so 3. Each first ticks on its first scheduled step (spawn
      // orders 1 and 2), with the time since its first step.
      expect(logOf(under!)).toEqual([[1, 0.5, 0.5], [3, 0.5, 0.5], [5, 0.5, 0.5]]);
      expect(logOf(over!)).toEqual([[1, 0.5, 0.5], [4, 0.75, 0.75]]);
    } finally {
      runtime.stop();
    }
  });
});

/** A Class with a 4-step Tick Interval whose Event Tick logs as `intervalTicker`'s, then runs `body`; `extra` declares `functions`. */
function scriptedTicker(classId: string, body: string, extra = "", isAsync = false, functions: string[] = []): CompiledScript {
  return {
    assetGuid: classId.toLowerCase(), classId, parentClassId: "Actor", anchors: [], actorDefaults: { tickInterval: 1 },
    entryPoints: [{ name: "onTick", event: "onTick", isAsync }, ...functions.map(name => ({ name, isAsync: false }))],
    source: `export ${isAsync ? "async " : ""}function onTick(ctx) {
        const log = ctx.self.getVariable("log") ?? [];
        log.push([ctx.tickIndex, ctx.deltaSeconds, ctx.getDeltaSeconds()]);
        ctx.self.setVariable("log", log);
        ${body}
      }
${extra}`,
  };
}

const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

describe("Get Delta Seconds around a Tick Interval Event Tick", () => {
  it("reads the world step again in a Delay that resumes after the tick that started it", async () => {
    const runtime = await intervalRuntime([scriptedTicker("Waiter", `
        if (ctx.tickIndex !== 4) return;
        await ctx.delay(0.5);
        ctx.self.setVariable("resumed", ctx.getDeltaSeconds());`, "", true)]);
    try {
      const waiter = runtime.spawnScriptedActor({ classId: "Waiter" })!;
      for (let step = 0; step < 8; step++) { runtime.tick(); await settle(); }
      expect(logOf(waiter)[1]).toEqual([4, 1, 1]);
      // The Delay started in the tick that read 1 s resumes on a later step, which reads one step.
      expect(waiter.getVariable("resumed")).toBe(0.25);
    } finally {
      runtime.stop();
    }
  });

  it("stops reading an Event Tick's delta once it throws or trips the infinite loop guard", async () => {
    const runtime = createInProcessRuntime({ seed: 1, preferSoftwarePhysics: true, dt: STEP, loopCount: 5 });
    await runtime.loadScripts([
      scriptedTicker("Faulty", `
        if (ctx.tickIndex === 4) throw new Error("tick failed");
        if (ctx.tickIndex === 8) for (;;) ctx.checkInfiniteLoop();`),
      intervalTicker("Steady"),
    ]);
    runtime.start();
    try {
      const faulty = runtime.spawnScriptedActor({ classId: "Faulty" })!;
      const steady = runtime.spawnScriptedActor({ classId: "Steady" })!;
      for (let step = 0; step < 10; step++) runtime.tick();
      expect(tickIndices(faulty)).toEqual([0, 4, 8]);
      expect(logOf(faulty)[1]).toEqual([4, 1, 1]);
      // Later in the step whose Event Tick threw, and on the step after the loop aborted step 8's actors.
      expect(logOf(steady).filter(([tickIndex]) => tickIndex === 4 || tickIndex === 9)).toEqual([[4, 0.25, 0.25], [9, 0.25, 0.25]]);
    } finally {
      runtime.stop();
    }
  });

  it("gives a function called from the Event Tick the caller's delta, and Begin Play of an actor it spawns one step", async () => {
    const runtime = await intervalRuntime([
      scriptedTicker("Caller", `
        if (ctx.tickIndex !== 4) return;
        ctx.invokeFunction(ctx.self.getVariable("callee"), "Probe", {});
        ctx.spawnActor("Spawned");`),
      scriptedTicker("Callee", "", `export function Probe(ctx) { ctx.self.setVariable("probed", ctx.getDeltaSeconds()); }`, false, ["Probe"]),
      {
        assetGuid: "spawned", classId: "Spawned", parentClassId: "Actor", anchors: [],
        entryPoints: [{ name: "begin", event: "onBeginPlay", isAsync: false }],
        source: `export function begin(ctx) { ctx.self.setVariable("began", ctx.getDeltaSeconds()); }`,
      },
    ]);
    try {
      const caller = runtime.spawnScriptedActor({ classId: "Caller" })!;
      // Spawn order 1 puts the callee's own Event Ticks on steps 3 and 7, never on step 4.
      const callee = runtime.spawnScriptedActor({ classId: "Callee" })!;
      caller.setVariable("callee", callee);
      for (let step = 0; step < 5; step++) runtime.tick();
      expect(tickIndices(callee)).toEqual([3]);
      // Called synchronously from the caller's 1 s Event Tick, the function runs as part of that tick.
      expect(callee.getVariable("probed")).toBe(1);
      // A spawn made mid-tick begins play after the actors phase, outside the Event Tick.
      const spawned = runtime.getWorld().getActors().filter(actor => actor.classId === "Spawned");
      expect(spawned.map(actor => actor.getVariable("began"))).toEqual([0.25]);
    } finally {
      runtime.stop();
    }
  });

  it("runs only the input events of a Class with a Tick Interval and no Event Tick", async () => {
    const runtime = await intervalRuntime([{
      assetGuid: "listener", classId: "Listener", parentClassId: "Actor", anchors: [], actorDefaults: { tickInterval: 1 },
      entryPoints: [{ name: "onInput", event: "onInput", isAsync: false }],
      source: `export function onInput(ctx) { ctx.self.setVariable("inputs", (ctx.self.getVariable("inputs") ?? 0) + 1); }`,
    }]);
    try {
      const listener = runtime.spawnScriptedActor({ classId: "Listener" })!;
      for (let step = 0; step < 6; step++) runtime.tick();
      expect(listener.getVariable("inputs")).toBe(6);
      expect(listener.tickStride).toBe(4);
      expect(listener.eventTickElapsed).toBe(0);
    } finally {
      runtime.stop();
    }
  });
});
