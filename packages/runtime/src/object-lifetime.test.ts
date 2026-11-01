import { afterEach, describe, expect, it } from "vitest";
import { createActor } from "@haptic/core";
import { EngineObject } from "@haptic/object-model";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import { compileClassScript, graphNode, startGraphScenario, wire, type GraphScenario } from "./testing/graph-scenario";
import type { RuntimeObjectLifetime } from "./object-lifetime";

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
