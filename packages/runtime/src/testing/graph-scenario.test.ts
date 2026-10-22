import { describe, expect, it } from "vitest";
import { createActor } from "@haptic/core";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import { compileClassScript, graphNode, startGraphScenario, wire } from "./graph-scenario";

const registry = createDefaultNodeRegistry();

const log = (id: string, message: string) =>
  graphNode(registry, id, "debug.log", { category: "Scenario", "default:message": message });

describe("startGraphScenario", () => {
  it("runs Begin Play before resolving and settles a Delay's continuation before the next tick", async () => {
    const script = compileClassScript({
      registry,
      classId: "Waiter",
      graph: {
        id: "event-graph",
        kind: "event",
        nodes: [
          graphNode(registry, "begin", "flow.event.beginPlay"),
          log("logBegin", "begin"),
          graphNode(registry, "delay", "timers.delay", { "default:duration": 0.01 }),
          log("logAfter", "after delay"),
          graphNode(registry, "tick", "flow.event.tick"),
          log("logTick", "tick"),
        ],
        edges: [
          wire("begin", "execOut", "logBegin", "execIn"),
          wire("logBegin", "execOut", "delay", "execIn"),
          wire("delay", "execOut", "logAfter", "execIn"),
          wire("tick", "execOut", "logTick", "execIn"),
        ],
      },
    });
    const scenario = await startGraphScenario({
      scripts: [script],
      actors: [createActor("waiter", "Waiter", { classId: "Waiter" })],
    });
    try {
      expect(scenario.logs("Scenario")).toEqual(["begin"]);
      await scenario.tick(3);
      expect(scenario.logs("Scenario")).toEqual(["begin", "tick", "after delay", "tick", "tick"]);
      expect(scenario.diagnostics()).toEqual([]);
    } finally { scenario.stop(); }
  });

  it("reports a node that throws against its Class and node", async () => {
    const script = compileClassScript({
      registry,
      classId: "Thrower",
      graph: {
        id: "event-graph",
        kind: "event",
        nodes: [
          graphNode(registry, "tick", "flow.event.tick"),
          graphNode(registry, "js", "debug.executeJavaScript", { body: "throw new Error(\"boom\");" }),
        ],
        edges: [wire("tick", "execOut", "js", "execIn")],
      },
    });
    const scenario = await startGraphScenario({
      scripts: [script],
      actors: [createActor("thrower", "Thrower", { classId: "Thrower" })],
    });
    try {
      await scenario.tick();
      expect(scenario.diagnostics()).toEqual([expect.objectContaining({
        code: "runtime.uncaught", assetGuid: "Thrower.class", graphId: "event-graph", nodeId: "js",
      })]);
    } finally { scenario.stop(); }
  });
});
