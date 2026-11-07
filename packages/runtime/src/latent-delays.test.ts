import { describe, expect, it } from "vitest";
import { createActor } from "@haptic/core";
import type { GraphEdge, GraphNode } from "@haptic/scripting";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import { compileClassScript, graphNode, startGraphScenario, wire } from "./testing/graph-scenario";

const registry = createDefaultNodeRegistry();
const log = (id: string, message: string) =>
  graphNode(registry, id, "debug.log", { category: "Waits", "default:message": message });

/** A `Waiter` actor per guid running `nodes` and `edges` from Event Tick (ticks of 1/60 s). */
async function tickScenario(nodes: GraphNode[], edges: GraphEdge[], guids = ["waiter"]) {
  const script = compileClassScript({
    registry,
    classId: "Waiter",
    graph: { id: "event-graph", kind: "event", nodes: [graphNode(registry, "tick", "flow.event.tick"), ...nodes], edges },
  });
  return startGraphScenario({
    scripts: [script],
    actors: guids.map((guid) => createActor(guid, "Waiter", { classId: "Waiter" })),
  });
}

describe("script Delay", () => {
  it("ends a counting Delay's graph quietly when its owner is destroyed instead of leaving it pending", async () => {
    const scenario = await startGraphScenario({
      actors: [createActor("actor", "Actor", { classId: "Delayed" })],
      scripts: [{ classId: "Delayed", parentClassId: "Actor", assetGuid: "delayed", anchors: [],
        source: `export async function begin(ctx) {
        try { await ctx.delay(10); } catch (error) { ctx.log("log", "test", "ended " + error.name); throw error; }
        ctx.log("log", "test", "continued");
      }`,
        entryPoints: [{ name: "begin", event: "onBeginPlay", isAsync: true }] }],
    });
    try {
      await scenario.tick();
      expect(scenario.runtime.executeConsoleCommand('destroyactor "actor"').success).toBe(true);
      await scenario.tick();
      expect(scenario.logs("test")).toEqual(["ended AbortError"]);
      expect(scenario.diagnostics()).toEqual([]);
    } finally { scenario.stop(); }
  });

  it("runs the nodes after Delay once per call, each Duration after its own call", async () => {
    // 0.03 s spans two ticks, so each call's Out runs in the tick after it.
    const scenario = await tickScenario(
      [log("before", "call"), graphNode(registry, "delay", "timers.delay", { "default:duration": 0.03 }), log("after", "done")],
      [wire("tick", "execOut", "before", "execIn"), wire("before", "execOut", "delay", "execIn"), wire("delay", "execOut", "after", "execIn")],
    );
    try {
      await scenario.tick(4);
      expect(scenario.logs("Waits")).toEqual(["call", "call", "done", "call", "done", "call", "done"]);
    } finally { scenario.stop(); }
  });

  it.each([
    // Delay One Tick continues in the next tick; Delay 0 once this tick's actors have ticked.
    ["Delay One Tick", graphNode(registry, "wait", "timers.delayOneTick"), ["call", "call", "done", "call", "done"]],
    ["Delay 0", graphNode(registry, "wait", "timers.delay", { "default:duration": 0 }), ["call", "done", "call", "done", "call", "done"]],
  ])("continues %s from Event Tick once per call", async (_name, wait, expected) => {
    const scenario = await tickScenario(
      [log("before", "call"), wait, log("after", "done")],
      [wire("tick", "execOut", "before", "execIn"), wire("before", "execOut", "wait", "execIn"), wire("wait", "execOut", "after", "execIn")],
    );
    try {
      await scenario.tick(3);
      expect(scenario.logs("Waits")).toEqual(expected);
    } finally { scenario.stop(); }
  });

  it("runs Retriggerable Delay's Out once, Duration after the last call, for each object on its own", async () => {
    // Do N calls it in the first three ticks; each call restarts the 0.03 s wait.
    const scenario = await tickScenario(
      [
        graphNode(registry, "count", "flow.doN", { "default:n": 3 }),
        log("before", "call"),
        graphNode(registry, "wait", "timers.retriggerableDelay", { "default:duration": 0.03 }),
        log("after", "done"),
      ],
      [
        wire("tick", "execOut", "count", "execIn"),
        wire("count", "then", "before", "execIn"),
        wire("before", "execOut", "wait", "execIn"),
        wire("wait", "execOut", "after", "execIn"),
      ],
      ["first", "second"],
    );
    try {
      await scenario.tick(3);
      expect(scenario.logs("Waits")).toEqual(["call", "call", "call", "call", "call", "call"]);
      await scenario.tick(3);
      expect(scenario.logs("Waits").slice(6)).toEqual(["done", "done"]);
      expect(scenario.diagnostics()).toEqual([]);
    } finally { scenario.stop(); }
  });
});
