import { afterEach, describe, expect, it } from "vitest";
import { createActor } from "@haptic/core";
import { EngineObject, TICKABLE_OBJECT_INTERFACE_GUID } from "@haptic/object-model";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import { compileClassScript, graphNode, startGraphScenario, wire, type GraphScenario } from "./testing/graph-scenario";
import type { RuntimeObjectLifetime } from "./object-lifetime";

const registry = createDefaultNodeRegistry();
const own = (name: string, typeId: string, typeClassId?: string) =>
  ({ variableName: name, typeId, ...(typeClassId ? { typeClassId } : {}), implicitSelf: true });

/** On Init sets Ready, then Late after a 0.1 s Delay; Tick adds one to Ticks. */
function countingGraph() {
  return {
    id: "event-graph",
    kind: "event" as const,
    nodes: [
      graphNode(registry, "init", "flow.event.init"),
      graphNode(registry, "ready", "variables.set", { ...own("Ready", "bool"), "default:value": true }),
      graphNode(registry, "wait", "timers.delay", { "default:duration": 0.1 }),
      graphNode(registry, "late", "variables.set", { ...own("Late", "bool"), "default:value": true }),
      graphNode(registry, "tick", "flow.event.tick"),
      graphNode(registry, "ticks", "variables.get", own("Ticks", "float")),
      graphNode(registry, "plus", "math.add", { "default:b": 1 }),
      graphNode(registry, "count", "variables.set", own("Ticks", "float")),
    ],
    edges: [
      wire("init", "execOut", "ready", "execIn"),
      wire("ready", "execOut", "wait", "execIn"),
      wire("wait", "execOut", "late", "execIn"),
      wire("tick", "execOut", "count", "execIn"),
      wire("ticks", "value", "plus", "a"),
      wire("plus", "out", "count", "value"),
    ],
  };
}

const counterVariables = [
  { name: "Ready", type: "bool", defaultValue: false },
  { name: "Late", type: "bool", defaultValue: false },
  { name: "Ticks", type: "float", defaultValue: 0 },
];
const counter = compileClassScript({
  registry, classId: "Counter", parentClassId: "Object", graph: countingGraph(),
  variables: counterVariables, implementedInterfaces: [TICKABLE_OBJECT_INTERFACE_GUID],
});
// The same graph without Tickable Object: its Tick never runs.
const idle = compileClassScript({ registry, classId: "Idle", parentClassId: "Object", graph: countingGraph(), variables: counterVariables });

/** Begin Play creates a Counter, an Idle and (refused) an Actor; Drop clears Held and asks for a pass. */
const maker = compileClassScript({
  registry,
  classId: "Maker",
  graph: {
    id: "event-graph",
    kind: "event",
    nodes: [
      graphNode(registry, "begin", "flow.event.beginPlay"),
      graphNode(registry, "makeCounter", "object.create", { "default:class": "Counter" }),
      graphNode(registry, "held", "variables.set", own("Held", "object", "Counter")),
      graphNode(registry, "makeIdle", "object.create", { "default:class": "Idle" }),
      graphNode(registry, "kept", "variables.set", own("Kept", "object", "Idle")),
      graphNode(registry, "makeActor", "object.create", { "default:class": "Maker" }),
      graphNode(registry, "refused", "variables.set", own("Refused", "object")),
      graphNode(registry, "drop", "flow.event.custom", { name: "Drop" }),
      graphNode(registry, "clear", "variables.set", own("Held", "object", "Counter")),
      graphNode(registry, "collect", "object.collectGarbage"),
    ],
    edges: [
      wire("begin", "execOut", "makeCounter", "execIn"),
      wire("makeCounter", "execOut", "held", "execIn"),
      wire("makeCounter", "object", "held", "value"),
      wire("held", "execOut", "makeIdle", "execIn"),
      wire("makeIdle", "execOut", "kept", "execIn"),
      wire("makeIdle", "object", "kept", "value"),
      wire("kept", "execOut", "makeActor", "execIn"),
      wire("makeActor", "execOut", "refused", "execIn"),
      wire("makeActor", "object", "refused", "value"),
      wire("drop", "execOut", "clear", "execIn"),
      wire("clear", "execOut", "collect", "execIn"),
    ],
  },
  variables: [{ name: "Held", type: "object", typeClassId: "Counter" }, { name: "Kept", type: "object", typeClassId: "Idle" }, { name: "Refused", type: "object" }],
});

let scenario: GraphScenario | null = null;
afterEach(() => scenario?.stop());

async function start() {
  // A long interval: only Collect Garbage and the Scene change run a pass.
  scenario = await startGraphScenario({
    scripts: [counter, idle, maker],
    actors: [createActor("maker-1", "Maker", { classId: "Maker" })],
    runtime: { garbageCollectionIntervalTicks: 10_000 },
  });
  const makerActor = scenario.runtime.getWorld().findActor("maker-1")!;
  const lifetime = (scenario.runtime as unknown as { objectLifetime: RuntimeObjectLifetime }).objectLifetime;
  return { scenario, makerActor, lifetime };
}

describe("Create Object in Play", () => {
  it("returns an object of the Class after its On Init ran, and ticks it only with Tickable Object", async () => {
    const { scenario, makerActor } = await start();
    await scenario.tick();
    const held = makerActor.getVariable("Held") as EngineObject;
    const kept = makerActor.getVariable("Kept") as EngineObject;
    expect(held).toBeInstanceOf(EngineObject);
    expect([held.classId, kept.classId]).toEqual(["Counter", "Idle"]);
    expect([held.getVariable("Ready"), kept.getVariable("Ready")]).toEqual([true, true]);
    const ticksBefore = held.getVariable("Ticks") as number;

    await scenario.tick(3);
    // One Tick per tick in the Objects phase; Idle has no Tickable Object.
    expect(held.getVariable("Ticks")).toBe(ticksBefore + 3);
    expect(kept.getVariable("Ticks")).toBe(0);
  });

  it("refuses a Class that is not a plain Object class", async () => {
    const { scenario, makerActor } = await start();
    await scenario.tick();
    expect(makerActor.getVariable("Refused")).toBeNull();
    expect(scenario.logs("Script")).toContain("Create Object cannot create Maker: choose a Class whose parent is Object.");
  });

  it("collects an object once nothing references it: it stops ticking and its waiting Delay never resumes", async () => {
    const { scenario, makerActor, lifetime } = await start();
    await scenario.tick();
    const held = makerActor.getVariable("Held") as EngineObject;
    const kept = makerActor.getVariable("Kept") as EngineObject;

    scenario.runtime.invokeScriptEvent("Maker", "Drop", makerActor);
    await scenario.tick();
    expect(held.destroyed).toBe(true);
    expect(kept.destroyed).toBe(false);
    expect(lifetime.lastPass).toMatchObject({ collected: 1, collectable: 1 });

    const ticksAtCollection = held.getVariable("Ticks");
    // 0.25 s at the default step: well past the 0.1 s Delay both objects started in On Init.
    await scenario.tick(15);
    expect(held.getVariable("Ticks")).toBe(ticksAtCollection);
    expect([held.getVariable("Late"), kept.getVariable("Late")]).toEqual([false, true]);
  });
});
