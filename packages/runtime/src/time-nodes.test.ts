import { afterEach, describe, expect, it, vi } from "vitest";
import { createActor } from "@haptic/core";
import { ENGINE_STRUCTS, type GraphEdge, type GraphNode, type LogicGraph } from "@haptic/scripting";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import { compileClassScript, graphNode, startGraphScenario, wire, type GraphScenario } from "./testing/graph-scenario";

const registry = createDefaultNodeRegistry();

/** `event` → one Print per source output, in order. */
function printGraph(event: string, sources: GraphNode[], outputs: [nodeId: string, pinId: string][]): LogicGraph {
  const prints = outputs.map((_, index) => graphNode(registry, `print${index}`, "debug.print"));
  const edges: GraphEdge[] = [];
  prints.forEach((print, index) => {
    edges.push(index === 0
      ? wire("event", "execOut", print.id, "execIn")
      : wire(prints[index - 1]!.id, "execOut", print.id, "execIn"));
    const [nodeId, pinId] = outputs[index]!;
    edges.push(wire(nodeId, pinId, print.id, "value"));
  });
  return {
    id: "event-graph",
    kind: "event",
    nodes: [graphNode(registry, "event", event), ...sources, ...prints],
    edges,
  };
}

function breakStructure(id: string, structGuid: string): GraphNode {
  const fields = ENGINE_STRUCTS.find((entry) => entry.id === structGuid)!.fields;
  return graphNode(registry, id, "struct.break", { structGuid, fields });
}

async function play(graph: LogicGraph, dt?: number): Promise<GraphScenario> {
  return startGraphScenario({
    scripts: [compileClassScript({ registry, classId: "Clock", graph })],
    actors: [createActor("clock", "Clock", { classId: "Clock" })],
    ...(dt === undefined ? {} : { dt }),
  });
}

function printed(scenario: GraphScenario): string[] {
  return scenario.commands.flatMap((command) => command.type === "print" ? [command.message] : []);
}

describe("Time nodes", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("read the dilated simulation step and the frames finished since Play started", async () => {
    const scenario = await play(printGraph("flow.event.tick", [
      graphNode(registry, "delta", "time.getDeltaSeconds"),
      graphNode(registry, "frames", "time.getCurrentFrameCount"),
    ], [["delta", "deltaSeconds"], ["frames", "frameCount"]]), 0.02);
    await scenario.tick(2);
    scenario.runtime.setTimeDilation(0.5);
    await scenario.tick();
    scenario.stop();
    expect(scenario.diagnostics()).toEqual([]);
    expect(printed(scenario)).toEqual(["0.02", "0", "0.02", "1", "0.01", "2"]);
  });

  it("read the wall clock in UTC as the engine Time and Date Structures and Unix milliseconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2024-02-29T23:59:59.999Z"));
    const graph = printGraph("flow.event.beginPlay", [
      graphNode(registry, "time", "time.getTimeNow"),
      graphNode(registry, "date", "time.getDateNow"),
      graphNode(registry, "ms", "time.getTimeMs"),
      breakStructure("breakTime", "engine:Time"),
      breakStructure("breakDate", "engine:Date"),
    ], [
      ["time", "time"], ["date", "date"], ["ms", "milliseconds"],
      ["breakTime", "Hour"], ["breakTime", "Millisecond"], ["breakDate", "DayOfWeek"], ["breakDate", "DayOfYear"],
    ]);
    graph.edges.push(wire("time", "time", "breakTime", "in"), wire("date", "date", "breakDate", "in"));
    const scenario = await play(graph);
    scenario.stop();
    expect(scenario.diagnostics()).toEqual([]);
    expect(printed(scenario)).toEqual([
      "{Hour: 23, Millisecond: 999, Minute: 59, Second: 59}",
      "{Day: 29, DayOfWeek: 4, DayOfYear: 60, Month: 2, Year: 2024}",
      "1709251199999",
      "23", "999", "4", "60",
    ]);
  });
});
