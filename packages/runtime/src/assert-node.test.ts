import { describe, expect, it } from "vitest";
import { createActor } from "@haptic/core";
import type { CompileOptions, LogicGraph } from "@haptic/scripting";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import { compileClassScript, graphNode, startGraphScenario, wire } from "./testing/graph-scenario";

const registry = createDefaultNodeRegistry();

/** Begin Play → Assert `checked` → Assert `unnamed` → Log "after", with each Condition a literal. */
function assertGraph(checked: boolean, unnamed: boolean): LogicGraph {
  return {
    id: "event-graph",
    kind: "event",
    nodes: [
      graphNode(registry, "begin", "flow.event.beginPlay"),
      graphNode(registry, "checked", "debug.assert", { "default:condition": checked, "default:message": "Health is positive" }),
      graphNode(registry, "unnamed", "debug.assert", { "default:condition": unnamed }),
      graphNode(registry, "after", "debug.log", { category: "Probe", "default:message": "after" }),
    ],
    edges: [
      wire("begin", "execOut", "checked", "execIn"),
      wire("checked", "execOut", "unnamed", "execIn"),
      wire("unnamed", "execOut", "after", "execIn"),
    ],
  };
}

async function run(graph: LogicGraph, compile?: Omit<CompileOptions, "assetGuid" | "registry">) {
  const scenario = await startGraphScenario({
    scripts: [compileClassScript({ registry, classId: "Hero", graph, compile })],
    actors: [createActor("hero", "Hero", { classId: "Hero" })],
  });
  scenario.stop();
  return scenario;
}

describe("Assert node", () => {
  it("reports each false Condition as an error for its node and carries on", async () => {
    const scenario = await run(assertGraph(false, false));
    expect(scenario.diagnostics()).toEqual([
      expect.objectContaining({ code: "runtime.assert", message: "Assertion failed: Health is positive",
        severity: "error", assetGuid: "Hero.class", graphId: "event-graph", nodeId: "checked" }),
      expect.objectContaining({ code: "runtime.assert", message: "Assertion failed",
        severity: "error", assetGuid: "Hero.class", graphId: "event-graph", nodeId: "unnamed" }),
    ]);
    expect(scenario.logs("Assert")).toEqual(["Assertion failed: Health is positive", "Assertion failed"]);
    expect(scenario.logs("Probe")).toEqual(["after"]);
  });

  it("reports nothing when the Condition holds", async () => {
    const scenario = await run(assertGraph(true, true));
    expect(scenario.diagnostics()).toEqual([]);
    expect(scenario.logs("Assert")).toEqual([]);
    expect(scenario.logs("Probe")).toEqual(["after"]);
  });

  it("is left out of release exports by default", async () => {
    const scenario = await run(assertGraph(false, false), { stripDevelopmentOnly: true });
    expect(scenario.diagnostics()).toEqual([]);
    expect(scenario.logs("Probe")).toEqual(["after"]);
  });

  it("reports Assert Equal with both values and Assert Is Valid for a missing object", async () => {
    const vector = (id: string) => graphNode(registry, id, "vector.make3", { "default:x": 1, "default:y": 2, "default:z": 3 });
    const sum = (id: string, b: number) => graphNode(registry, id, "math.add", { "default:a": 1, "default:b": b });
    const scenario = await run({
      id: "event-graph",
      kind: "event",
      nodes: [
        graphNode(registry, "begin", "flow.event.beginPlay"),
        vector("v1"), vector("v2"),
        graphNode(registry, "sameVectors", "debug.assertEqual", { "default:message": "Same spot" }),
        sum("two", 1), sum("three", 2),
        graphNode(registry, "score", "debug.assertEqual", { "default:message": "Score" }),
        graphNode(registry, "self", "actor.getSelf"),
        graphNode(registry, "hasSelf", "debug.assertIsValid", { "default:message": "Self" }),
        graphNode(registry, "target", "debug.assertIsValid", { "default:message": "Target" }),
        graphNode(registry, "after", "debug.log", { category: "Probe", "default:message": "after" }),
      ],
      edges: [
        wire("begin", "execOut", "sameVectors", "execIn"),
        wire("v1", "out", "sameVectors", "actual"),
        wire("v2", "out", "sameVectors", "expected"),
        wire("sameVectors", "execOut", "score", "execIn"),
        wire("two", "out", "score", "actual"),
        wire("three", "out", "score", "expected"),
        wire("score", "execOut", "hasSelf", "execIn"),
        wire("self", "out", "hasSelf", "object"),
        wire("hasSelf", "execOut", "target", "execIn"),
        wire("target", "execOut", "after", "execIn"),
      ],
    });
    expect(scenario.diagnostics()).toEqual([
      expect.objectContaining({ code: "runtime.assert", message: "Assertion failed: Score (expected 3, got 2)", nodeId: "score" }),
      expect.objectContaining({ code: "runtime.assert", message: "Assertion failed: Target (the object is not valid)", nodeId: "target" }),
    ]);
    expect(scenario.logs("Probe")).toEqual(["after"]);
  });
});
