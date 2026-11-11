import { describe, expect, it } from "vitest";
import { createActor } from "@haptic/core";
import { ENGINE_TIMER_HANDLE_STRUCT_ID, type GraphNode, type LogicGraph } from "@haptic/scripting";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import { compileClassScript, graphNode, startGraphScenario, wire } from "./testing/graph-scenario";

const registry = createDefaultNodeRegistry();
const handleVariable = { variableName: "Timer", typeId: "struct", typeClassId: ENGINE_TIMER_HANDLE_STRUCT_ID, implicitSelf: true };

/** Begin Play sets a looping Ping timer and keeps its handle in Timer; Ping logs, then optionally clears it through Timer. */
function timerGraph(clearOnFirst: boolean): LogicGraph {
  const nodes: GraphNode[] = [
    graphNode(registry, "begin", "flow.event.beginPlay"),
    graphNode(registry, "set", "timers.setTimerByEvent", { "default:time": 0.5, "default:looping": true }),
    graphNode(registry, "keep", "variables.set", handleVariable),
    graphNode(registry, "ping", "flow.event.custom", { name: "Ping", pins: [] }),
    graphNode(registry, "log", "debug.log", { category: "Ping", "default:message": "ping" }),
    graphNode(registry, "timer", "variables.get", handleVariable),
    graphNode(registry, "clear", "timers.clearAndInvalidateTimer"),
  ];
  const edges = [
    wire("begin", "execOut", "set", "execIn"), wire("ping", "OutputDelegate", "set", "event"),
    wire("set", "execOut", "keep", "execIn"), wire("set", "handle", "keep", "value"),
    wire("ping", "execOut", "log", "execIn"), wire("timer", "value", "clear", "handle"),
    ...(clearOnFirst ? [wire("log", "execOut", "clear", "execIn")] : []),
  ];
  return { id: "event-graph", kind: "event", nodes, edges };
}

async function play(clearOnFirst: boolean, ticks: number) {
  const scenario = await startGraphScenario({
    scripts: [compileClassScript({ registry, classId: "Clock", graph: timerGraph(clearOnFirst),
      variables: [{ name: "Timer", type: "struct", typeClassId: ENGINE_TIMER_HANDLE_STRUCT_ID, defaultValue: { Id: 0 } }] })],
    actors: [createActor("clock", "Clock", { classId: "Clock" })],
    dt: 0.25,
  });
  await scenario.tick(ticks);
  const clock = scenario.runtime.getWorld().getActors()[0]!;
  scenario.stop();
  return { pings: scenario.logs("Ping").length, handle: clock.getVariable("Timer"), diagnostics: scenario.diagnostics() };
}

describe("Timer nodes", () => {
  it("run an event every interval of game time through Set Timer By Event", async () => {
    const result = await play(false, 8);
    expect(result.diagnostics).toEqual([]);
    expect(result.pings).toBe(4);
    expect(result.handle).toEqual({ Id: expect.any(Number) });
    expect((result.handle as { Id: number }).Id).toBeGreaterThan(0);
  });

  it("log an error and set no timer when Set Timer By Event has no Event", async () => {
    const graph: LogicGraph = {
      id: "event-graph", kind: "event",
      nodes: [
        graphNode(registry, "begin", "flow.event.beginPlay"),
        graphNode(registry, "set", "timers.setTimerByEvent", { "default:time": 0.5 }),
        graphNode(registry, "keep", "variables.set", handleVariable),
      ],
      edges: [wire("begin", "execOut", "set", "execIn"), wire("set", "execOut", "keep", "execIn"), wire("set", "handle", "keep", "value")],
    };
    const scenario = await startGraphScenario({
      scripts: [compileClassScript({ registry, classId: "Clock", graph,
        variables: [{ name: "Timer", type: "struct", typeClassId: ENGINE_TIMER_HANDLE_STRUCT_ID, defaultValue: { Id: 7 } }] })],
      actors: [createActor("clock", "Clock", { classId: "Clock" })],
      dt: 0.25,
    });
    await scenario.tick(1);
    const clock = scenario.runtime.getWorld().getActors()[0]!;
    scenario.stop();

    expect(scenario.logs("Script")).toEqual(["Clock: Set Timer By Event (Event) tried to access null."]);
    // The nodes after it still run, with a handle that names no timer.
    expect((clock.getVariable("Timer") as { Id?: number }).Id ?? 0).toBe(0);
  });

  it("stop for good and empty the handle variable with Clear And Invalidate Timer By Handle", async () => {
    const result = await play(true, 8);
    expect(result.diagnostics).toEqual([]);
    expect(result.pings).toBe(1);
    expect(result.handle).toEqual({ Id: 0 });
  });
});
