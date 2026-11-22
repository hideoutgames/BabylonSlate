import { afterEach, describe, expect, it } from "vitest";
import { createActor } from "@haptic/core";
import { ClassRegistry, EngineObject, World } from "@haptic/object-model";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import { compileClassScript, graphNode, startGraphScenario, wire, type GraphScenario } from "./testing/graph-scenario";
import { GARBAGE_COLLECTION_SLICE_WORK, RuntimeObjectLifetime } from "./object-lifetime";

const registry = createDefaultNodeRegistry();
const variable = (name: string) => ({ variableName: name, typeId: "object", typeClassId: "Object", implicitSelf: true });

/**
 * Hold: Validated Get reads Seed into the frame, Seed is cleared, a Delay waits
 * one second, then After receives the value the frame kept.
 */
const keeper = compileClassScript({
  registry,
  classId: "Keeper",
  graph: {
    id: "event-graph",
    kind: "event",
    nodes: [
      graphNode(registry, "hold", "flow.event.custom", { name: "Hold" }),
      graphNode(registry, "seed", "variables.getValidated", variable("Seed")),
      graphNode(registry, "clear", "variables.set", variable("Seed")),
      graphNode(registry, "wait", "timers.delay", { "default:duration": 1 }),
      graphNode(registry, "after", "variables.set", variable("After")),
    ],
    edges: [
      wire("hold", "execOut", "seed", "execIn"),
      wire("seed", "isValid", "clear", "execIn"),
      wire("clear", "execOut", "wait", "execIn"),
      wire("wait", "execOut", "after", "execIn"),
      wire("seed", "value", "after", "value"),
    ],
  },
});

let scenario: GraphScenario | null = null;
afterEach(() => scenario?.stop());

async function start() {
  scenario = await startGraphScenario({
    scripts: [keeper],
    actors: [createActor("keeper-1", "Keeper", { classId: "Keeper" }), createActor("keeper-2", "Spare", { classId: "Keeper" })],
    dt: 0.25,
    runtime: { garbageCollectionIntervalTicks: 1 },
  });
  const lifetime = (scenario.runtime as unknown as { objectLifetime: RuntimeObjectLifetime }).objectLifetime;
  const keeperActor = scenario.runtime.getWorld().findActor("keeper-1")!;
  return { scenario, lifetime, keeperActor };
}

describe("object lifetime in Play", () => {
  it("keeps an object that only a waiting Delay frame holds, then collects it once nothing does", async () => {
    const { scenario, lifetime, keeperActor } = await start();
    const held = new EngineObject({ classId: "Object", guid: "held" });
    lifetime.collector.register(held);
    keeperActor.setVariable("Seed", held);
    scenario.runtime.invokeScriptEvent("Keeper", "Hold", keeperActor);
    await scenario.tick();
    expect(keeperActor.getVariable("Seed")).toBeNull();

    // Two passes run while the Delay waits; only its frame holds the object.
    await scenario.tick(2);
    expect(held.destroyed).toBe(false);

    await scenario.tick(2);
    expect(keeperActor.getVariable("After")).toBe(held);
    expect(held.destroyed).toBe(false);

    keeperActor.setVariable("After", null);
    await scenario.tick();
    expect(held.destroyed).toBe(true);
    expect(lifetime.lastPass).toMatchObject({ collected: 1, collectable: 0 });
  });

  it("sets a stored reference to a destroyed actor to None at the next pass", async () => {
    const { scenario, keeperActor } = await start();
    const doomed = scenario.runtime.getWorld().findActor("keeper-2")!;
    keeperActor.setVariable("Seed", doomed);
    scenario.runtime.getWorld().destroyActorInstance(doomed);
    await scenario.tick();
    expect(keeperActor.getVariable("Seed")).toBeNull();
  });
});

describe("object lifetime controls", () => {
  /** A Keeper session with one registered object nothing references; returns the ticks each pass ran at. */
  async function passTicks(interval: number, ticks: number): Promise<number[]> {
    const run = await startGraphScenario({
      scripts: [keeper],
      actors: [createActor("keeper-1", "Keeper", { classId: "Keeper" })],
      runtime: { garbageCollectionIntervalTicks: interval },
    });
    try {
      const lifetime = (run.runtime as unknown as { objectLifetime: RuntimeObjectLifetime }).objectLifetime;
      const seen: number[] = [];
      for (let index = 0; index < ticks; index++) {
        // A fresh orphan each tick, so every due pass has work.
        lifetime.collector.register(new EngineObject({ classId: "Object", guid: `orphan-${index}` }));
        await run.tick();
        const tick = lifetime.lastPass?.tickIndex;
        if (tick !== undefined && seen.at(-1) !== tick) seen.push(tick);
      }
      return seen;
    } finally {
      run.stop();
    }
  }

  it("runs a pass every Garbage Collection Interval ticks, on the same ticks in every run", async () => {
    const first = await passTicks(4, 12);
    // The Scene's first tick also runs one (a Scene change); then every fourth tick index.
    expect(first.filter((tick) => tick > 0)).toEqual([4, 8, 12]);
    expect(await passTicks(4, 12)).toEqual(first);
  });

  it("gc requests a pass at the end of the tick and gc stats reports it", async () => {
    const run = await startGraphScenario({
      scripts: [keeper],
      actors: [createActor("keeper-1", "Keeper", { classId: "Keeper" })],
      runtime: { garbageCollectionIntervalTicks: 10_000, includeDebugCommands: true },
    });
    try {
      await run.tick();
      const lifetime = (run.runtime as unknown as { objectLifetime: RuntimeObjectLifetime }).objectLifetime;
      const orphan = new EngineObject({ classId: "Object", guid: "orphan" });
      lifetime.collector.register(orphan);
      expect(run.runtime.executeConsoleCommand("gc stats").output).toMatch(/^1 collectable objects; /);
      expect(run.runtime.executeConsoleCommand("gc")).toEqual({ success: true, output: "gc requested for the end of this tick" });
      expect(orphan.destroyed).toBe(false);
      await run.tick();
      expect(orphan.destroyed).toBe(true);
      expect(run.runtime.executeConsoleCommand("gc stats").output).toMatch(
        /^0 collectable objects; last pass at tick \d+: \d+ reached, 1 collected, 0 references cleared, \d+\.\d\d ms$/);
    } finally {
      run.stop();
    }
  });
});

describe("object lifetime across script hot reload", () => {
  it("scans a variable that a reloaded class now declares as an object", () => {
    const classRegistry = new ClassRegistry();
    const holderClass = (type: string) => ({ id: "Holder", parentClassId: "Actor", kind: "actor" as const,
      variables: [{ name: "Slot", type }], implementedInterfaces: [] });
    classRegistry.register(holderClass("number"));
    const world = new World({ seed: 1, dt: 1 / 60, classRegistry });
    const holder = world.spawnActorNow(world.createActor({ classId: "Holder" }));
    const lifetime = new RuntimeObjectLifetime({ world: () => world, roots: () => [holder], intervalTicks: () => 1, now: () => 0 });
    lifetime.request();
    lifetime.afterTick(0);

    classRegistry.unregister("Holder");
    classRegistry.register(holderClass("object"));
    const held = new EngineObject({ classId: "Object" });
    lifetime.collector.register(held);
    holder.setVariable("Slot", held);
    lifetime.request();
    lifetime.afterTick(1);
    expect(held.destroyed).toBe(false);
  });
});

const COMPONENT_PROPERTIES: Array<[string, Record<string, unknown>]> = [
  ["MeshComponent", { meshKind: "box", assetGuid: null, materialGuid: null, collisionMode: "none", layer: 1, mask: 0xffffffff }],
  ["PointLightComponent", { color: [1, 0.9, 0.8], intensity: 2, range: 10, castShadows: false }],
  ["ColliderComponent", { shape: { kind: "box", size: [1, 1, 1] }, isTrigger: false, friction: 0.5 }],
  ["RigidBodyComponent", { motionType: "dynamic", mass: 1, lockRotation: [false, false, false] }],
];
/** No owner in `largeWorld` holds more values than this, so a slice can pass the budget by at most this much. */
const LARGEST_OWNER_WORK = 16;

/** `count` actors with two to four engine components each, listed as Play lists its roots. */
function largeWorld(count: number, intervalTicks = 60, now: () => number = () => 0) {
  const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
  for (let index = 0; index < count; index++) {
    const actor = world.spawnActorNow(world.createActor({ classId: "Actor", guid: `actor-${index}`, variables: { Health: 100, Tags: ["enemy"] } }));
    for (let slot = 0; slot < 2 + (index % 3); slot++) {
      const [classId, properties] = COMPONENT_PROPERTIES[(index + slot) % COMPONENT_PROPERTIES.length]!;
      actor.attachComponent(world.createComponent({ classId, guid: `actor-${index}:${slot}`, variables: structuredClone(properties) }));
    }
  }
  const roots = () => world.getActors().flatMap((actor) => [actor, ...actor.components]);
  const lifetime = new RuntimeObjectLifetime({ world: () => world, roots, intervalTicks: () => intervalTicks, now });
  return { world, roots, lifetime };
}

/** Runs ticks from `first` until the cycle started there has finished; returns each tick's work units. */
function runCycle(lifetime: RuntimeObjectLifetime, first: number): number[] {
  const work: number[] = [];
  for (let tick = first; tick === first || lifetime.collector.collecting; tick++) {
    const before = lifetime.collector.workDone;
    lifetime.afterTick(tick);
    work.push(lifetime.collector.workDone - before);
  }
  return work;
}

describe("object lifetime collection slices", () => {
  it("spreads a cycle over ticks within the slice budget at 3,000 actors", () => {
    const { world, lifetime } = largeWorld(3000);
    const doomed = world.findActor("actor-0")!;
    const holder = world.findActor("actor-1")!;
    holder.setVariable("Target", doomed);
    world.destroyActorInstance(doomed);
    world.flushPending();

    const work = runCycle(lifetime, 60);

    expect(work.length).toBeGreaterThan(10);
    expect(Math.max(...work)).toBeLessThanOrEqual(GARBAGE_COLLECTION_SLICE_WORK + LARGEST_OWNER_WORK);
    expect(lifetime.lastPass).toMatchObject({ tickIndex: 60 + work.length - 1, ticks: work.length, collected: 0 });
    expect(holder.getVariable("Target")).toBeNull();
  });

  it("collects an unreachable object at 3,000 actors with only the finishing tick over budget, below a full pass", () => {
    const { roots, lifetime } = largeWorld(3000);
    const before = lifetime.collector.workDone;
    lifetime.collector.collect(roots());
    const fullPass = lifetime.collector.workDone - before;
    const orphan = new EngineObject({ classId: "Object", guid: "orphan" });
    lifetime.collector.register(orphan);

    const work = runCycle(lifetime, 60);

    expect(Math.max(...work.slice(0, -1))).toBeLessThanOrEqual(GARBAGE_COLLECTION_SLICE_WORK + LARGEST_OWNER_WORK);
    // The finishing tick rechecks roots, owners and containers instead of marking again.
    expect(work.at(-1)!).toBeLessThan(fullPass);
    expect(orphan.destroyed).toBe(true);
  });

  it("collects the same objects on the same ticks in every run, whatever the wall clock says", () => {
    function run(clockStep: number): string[] {
      let clock = 0;
      const { world, lifetime } = largeWorld(400, 10, () => (clock += clockStep));
      const collected: string[] = [];
      let tick = 0;
      lifetime.collector.onRelease((object) => collected.push(`${tick}:${object.guid}`));
      let longestCycle = 0;
      for (tick = 1; tick <= 120; tick++) {
        const created = new EngineObject({ classId: "Object", guid: `object-${tick}` });
        lifetime.collector.register(created);
        // Every third object is held until a later tick lets go of it; the rest are dropped at once.
        if (tick % 3 === 0) world.findActor(`actor-${tick % 20}`)!.setVariable("Held", [created]);
        if (tick % 7 === 0) world.findActor(`actor-${(tick * 3) % 20}`)!.setVariable("Held", null);
        if (tick % 11 === 0) {
          world.destroyActorInstance(world.findActor(`actor-${100 + tick}`)!);
          world.flushPending();
        }
        lifetime.afterTick(tick);
        longestCycle = Math.max(longestCycle, lifetime.lastPass?.ticks ?? 0);
      }
      expect(longestCycle).toBeGreaterThan(1);
      return collected;
    }

    const first = run(0.001);
    expect(first.length).toBeGreaterThan(40);
    expect(run(250)).toEqual(first);
  });
});
