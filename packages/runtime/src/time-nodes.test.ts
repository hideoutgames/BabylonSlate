import { afterEach, describe, expect, it, vi } from "vitest";
import { createActor } from "@haptic/core";
import { ENGINE_STRUCTS, type GraphEdge, type GraphNode, type LogicGraph } from "@haptic/scripting";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import { compileClassScript, graphNode, startGraphScenario, wire, type GraphScenario } from "./testing/graph-scenario";

const registry = createDefaultNodeRegistry();

type Step = { node: GraphNode; execIn?: string; execOut?: string } | { print: [nodeId: string, pinId: string] };

/** `event` → each step in order: an exec node, or a Print of a source output. Sources join the graph unwired. */
function chain(prefix: string, event: string, steps: Step[], sources: GraphNode[] = []): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const entry = graphNode(registry, `${prefix}event`, event);
  const nodes: GraphNode[] = [entry, ...sources];
  const edges: GraphEdge[] = [];
  let previous = entry.id;
  steps.forEach((step, index) => {
    const node = "node" in step ? step.node : graphNode(registry, `${prefix}print${index}`, "debug.print");
    nodes.push(node);
    edges.push(wire(previous, "execOut", node.id, "execIn"));
    if ("print" in step) edges.push(wire(step.print[0], step.print[1], node.id, "value"));
    previous = node.id;
  });
  return { nodes, edges };
}

function graphOf(...chains: { nodes: GraphNode[]; edges: GraphEdge[] }[]): LogicGraph {
  return { id: "event-graph", kind: "event", nodes: chains.flatMap((c) => c.nodes), edges: chains.flatMap((c) => c.edges) };
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
  const zone = process.env.TZ;
  afterEach(() => {
    vi.useRealTimers();
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  it("read the dilated simulation step and the frames finished since Play started", async () => {
    const scenario = await play(graphOf(chain("t", "flow.event.tick", [{ print: ["delta", "deltaSeconds"] }, { print: ["frames", "frameCount"] }], [
      graphNode(registry, "delta", "time.getDeltaSeconds"),
      graphNode(registry, "frames", "time.getCurrentFrameCount"),
    ])), 0.02);
    await scenario.tick(2);
    scenario.runtime.setTimeDilation(0.5);
    await scenario.tick();
    scenario.stop();
    expect(scenario.diagnostics()).toEqual([]);
    expect(printed(scenario)).toEqual(["0.02", "0", "0.02", "1", "0.01", "2"]);
  });

  it("set time dilation within 0 to 8 from the next step, and add up game time with it and real time without", async () => {
    const scenario = await play(graphOf(
      chain("b", "flow.event.beginPlay", [
        { node: graphNode(registry, "tooFast", "time.setTimeDilation", { "default:timeDilation": 20 }) },
        { print: ["dilation", "timeDilation"] },
        { node: graphNode(registry, "half", "time.setTimeDilation", { "default:timeDilation": 0.5 }) },
        { print: ["dilation", "timeDilation"] },
        { print: ["game", "seconds"] },
      ], [graphNode(registry, "dilation", "time.getTimeDilation")]),
      chain("t", "flow.event.tick", [{ print: ["game", "seconds"] }, { print: ["real", "seconds"] }, { print: ["delta", "deltaSeconds"] }], [
        graphNode(registry, "game", "time.getGameTimeSeconds"),
        graphNode(registry, "real", "time.getRealTimeSeconds"),
        graphNode(registry, "delta", "time.getDeltaSeconds"),
      ]),
    ), 0.02);
    await scenario.tick(2);
    scenario.stop();
    expect(scenario.diagnostics()).toEqual([]);
    expect(printed(scenario)).toEqual([
      "8", "0.5", "0",
      "0.01", "0.02", "0.01",
      "0.02", "0.04", "0.01",
    ]);
  });

  it("keep ticking at time dilation 0, with no game time passing and real time still advancing", async () => {
    const scenario = await play(graphOf(
      chain("b", "flow.event.beginPlay", [{ node: graphNode(registry, "freeze", "time.setTimeDilation", { "default:timeDilation": 0 }) }]),
      chain("t", "flow.event.tick", [{ print: ["delta", "deltaSeconds"] }, { print: ["game", "seconds"] }, { print: ["real", "seconds"] }], [
        graphNode(registry, "delta", "time.getDeltaSeconds"),
        graphNode(registry, "game", "time.getGameTimeSeconds"),
        graphNode(registry, "real", "time.getRealTimeSeconds"),
      ]),
    ), 0.02);
    await scenario.tick(2);
    scenario.stop();
    expect(printed(scenario)).toEqual(["0", "0", "0.02", "0", "0", "0.04"]);
  });

  it("read the wall clock in UTC as the engine Time and Date Structures and Unix milliseconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2024-02-29T23:59:59.999Z"));
    const built = chain("b", "flow.event.beginPlay", [
      { print: ["time", "time"] }, { print: ["date", "date"] }, { print: ["ms", "milliseconds"] },
      { print: ["breakTime", "Hour"] }, { print: ["breakTime", "Millisecond"] },
      { print: ["breakDate", "DayOfWeek"] }, { print: ["breakDate", "DayOfYear"] },
    ], [
      graphNode(registry, "time", "time.getTimeNow"),
      graphNode(registry, "date", "time.getDateNow"),
      graphNode(registry, "ms", "time.getTimeMs"),
      breakStructure("breakTime", "engine:Time"),
      breakStructure("breakDate", "engine:Date"),
    ]);
    built.edges.push(wire("time", "time", "breakTime", "in"), wire("date", "date", "breakDate", "in"));
    const scenario = await play(graphOf(built));
    scenario.stop();
    expect(scenario.diagnostics()).toEqual([]);
    expect(printed(scenario)).toEqual([
      "{Hour: 23, Millisecond: 999, Minute: 59, Second: 59}",
      "{Day: 29, DayOfWeek: 4, DayOfYear: 60, Month: 2, Year: 2024}",
      "1709251199999",
      "23", "999", "4", "60",
    ]);
  });

  it("read the wall clock in the device's time zone with the same Structures", async () => {
    process.env.TZ = "Asia/Kolkata";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2024-12-31T20:00:00.250Z"));
    const scenario = await play(graphOf(chain("b", "flow.event.beginPlay", [{ print: ["time", "time"] }, { print: ["date", "date"] }], [
      graphNode(registry, "time", "time.getLocalTimeNow"),
      graphNode(registry, "date", "time.getLocalDateNow"),
    ])));
    scenario.stop();
    expect(scenario.diagnostics()).toEqual([]);
    expect(printed(scenario)).toEqual([
      "{Hour: 1, Millisecond: 250, Minute: 30, Second: 0}",
      "{Day: 1, DayOfWeek: 3, DayOfYear: 1, Month: 1, Year: 2025}",
    ]);
  });
});
