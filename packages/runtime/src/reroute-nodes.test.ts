import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@haptic/bridge";
import { createActor } from "@haptic/core";
import type { GraphEdge } from "@haptic/scripting";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import { compileClassScript, graphNode, startGraphScenario } from "./testing/graph-scenario";

const registry = createDefaultNodeRegistry();
const HERO = { kind: "class", classId: "Hero" } as const;

const segment = (id: string, from: string, to: string): GraphEdge => {
  const [sourceNodeId, sourcePinId] = from.split(".") as [string, string];
  const [targetNodeId, targetPinId] = to.split(".") as [string, string];
  return { id, sourceNodeId, sourcePinId, targetNodeId, targetPinId };
};

/**
 * `event` → exec knot → Print String, whose In String reads "knotted" through two knots. Each
 * wire segment has its own id, as the canvas authors them.
 */
function heroScript(event: "flow.event.beginPlay" | "flow.event.tick") {
  return compileClassScript({
    registry,
    classId: "Hero",
    compile: { instrumentExecutionTrace: true },
    graph: {
      id: "event-graph",
      kind: "event",
      nodes: [
        graphNode(registry, "event", event),
        graphNode(registry, "execKnot", "flow.reroute"),
        graphNode(registry, "print", "debug.printString"),
        graphNode(registry, "text", "literal.makeString", { "default:in": "knotted" }),
        graphNode(registry, "dataKnot1", "flow.reroute"),
        graphNode(registry, "dataKnot2", "flow.reroute"),
      ],
      edges: [
        segment("x1", "event.execOut", "execKnot.in"),
        segment("x2", "execKnot.out", "print.execIn"),
        segment("d1", "text.out", "dataKnot1.in"),
        segment("d2", "dataKnot1.out", "dataKnot2.in"),
        segment("d3", "dataKnot2.out", "print.inString"),
      ],
    },
  });
}

const prints = (commands: readonly CommandMessage[]) =>
  commands.flatMap((command) => (command.type === "print" ? [command.message] : []));

describe("Reroute knots at run time", () => {
  it("run Begin Play's Print once, with the value carried through two knots unchanged", async () => {
    const scenario = await startGraphScenario({
      scripts: [heroScript("flow.event.beginPlay")],
      actors: [createActor("hero-1", "Hero", { classId: "Hero" })],
    });
    try {
      await scenario.tick(3);
      expect(prints(scenario.commands)).toEqual(["knotted"]);
      expect(scenario.diagnostics()).toEqual([]);
    } finally {
      scenario.stop();
    }
  });

  it("report every authored segment of an exec wire through a knot in the execution trace", async () => {
    const scenario = await startGraphScenario({
      scripts: [heroScript("flow.event.tick")],
      actors: [createActor("hero-1", "Hero", { classId: "Hero" })],
    });
    try {
      scenario.runtime.applyDebugObserve(HERO, "hero-1");
      const mark = scenario.commands.length;
      await scenario.tick();
      const traces = scenario.commands.slice(mark).flatMap((command) => (command.type === "executionTrace" ? [command] : []));
      expect(traces).toHaveLength(1);
      // Knots never run: the trace names the real nodes and both segments of the exec wire.
      expect(traces[0]!.graphs[0]).toMatchObject({
        assetGuid: "Hero.class",
        graphId: "event-graph",
        nodes: ["event", "print"],
        edges: ["x1", "x2"],
      });
      // The step into Print came over the segment that enters it.
      expect(traces[0]!.steps?.map((step) => [step[1], step[2]])).toEqual([["event", null], ["print", "x2"]]);
      expect(prints(scenario.commands.slice(mark))).toEqual(["knotted"]);
    } finally {
      scenario.stop();
    }
  });
});
