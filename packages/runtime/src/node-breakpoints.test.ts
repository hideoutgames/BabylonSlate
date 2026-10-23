import { describe, expect, it } from "vitest";
import type { BehaviourTreeDocument } from "@haptic/behaviour-tree";
import { BREAKPOINT_PAUSE_CODE, BT_DEBUG_GRAPH_ID, type CommandMessage } from "@haptic/bridge";
import { createActor } from "@haptic/core";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import { compileClassScript, graphNode, startGraphScenario, wire } from "./testing/graph-scenario";

const registry = createDefaultNodeRegistry();

const log = (id: string, message: string) =>
  graphNode(registry, id, "debug.log", { category: "Scenario", "default:message": message });

/** A Class that logs "begin" on Begin Play, and "a" then "b" every tick. */
function heroScript(compile: Parameters<typeof compileClassScript>[0]["compile"] = { instrumentBreakpoints: true }) {
  return compileClassScript({
    registry,
    classId: "Hero",
    compile,
    graph: {
      id: "event-graph",
      kind: "event",
      nodes: [
        graphNode(registry, "begin", "flow.event.beginPlay"),
        log("logBegin", "begin"),
        graphNode(registry, "tick", "flow.event.tick"),
        log("logA", "a"),
        log("logB", "b"),
      ],
      edges: [
        wire("begin", "execOut", "logBegin", "execIn"),
        wire("tick", "execOut", "logA", "execIn"),
        wire("logA", "execOut", "logB", "execIn"),
      ],
    },
  });
}

const heroes = [
  createActor("hero-1", "First", { classId: "Hero" }),
  createActor("hero-2", "Second", { classId: "Hero" }),
];

const at = (nodeId: string) => ({ assetGuid: "Hero.class", graphId: "event-graph", nodeId });

const pauses = (commands: readonly CommandMessage[]) =>
  commands.flatMap((command) => command.type === "sessionPaused" && command.cause ? [command.cause] : []);

describe("node breakpoints", () => {
  it("stop at the end of the tick the node ran in, naming the node, its event and the first object to reach it", async () => {
    const scenario = await startGraphScenario({
      scripts: [heroScript()],
      actors: heroes,
      runtime: { breakpoints: [at("logA")] },
    });
    try {
      await scenario.tick();
      // Both heroes finish the tick; only the first hit is reported.
      expect(scenario.logs("Scenario")).toEqual(["begin", "begin", "a", "b", "a", "b"]);
      expect(pauses(scenario.commands)).toEqual([{
        code: BREAKPOINT_PAUSE_CODE, message: "Breakpoint", assetGuid: "Hero.class", graphId: "event-graph",
        nodeId: "logA", entryNodeId: "tick", instanceId: "hero-1", instanceLabel: "First",
      }]);
      await scenario.tick();
      expect(scenario.logs("Scenario")).toHaveLength(6);

      scenario.runtime.resume();
      await scenario.tick();
      expect(scenario.logs("Scenario")).toHaveLength(10);
      expect(pauses(scenario.commands)).toHaveLength(2);
    } finally { scenario.stop(); }
  });

  it("stop on an event node before the first tick", async () => {
    const scenario = await startGraphScenario({
      scripts: [heroScript()],
      actors: heroes.slice(0, 1),
      runtime: { breakpoints: [at("begin")] },
    });
    try {
      expect(pauses(scenario.commands)).toEqual([expect.objectContaining({ nodeId: "begin", entryNodeId: "begin" })]);
      await scenario.tick();
      expect(scenario.logs("Scenario")).toEqual(["begin"]);
    } finally { scenario.stop(); }
  });

  it("change while the session runs", async () => {
    const scenario = await startGraphScenario({ scripts: [heroScript()], actors: heroes.slice(0, 1) });
    try {
      await scenario.tick();
      expect(pauses(scenario.commands)).toEqual([]);
      scenario.runtime.applyBreakpoints([at("logB")]);
      await scenario.tick();
      expect(pauses(scenario.commands)).toEqual([expect.objectContaining({ nodeId: "logB" })]);

      scenario.runtime.applyBreakpoints([]);
      scenario.runtime.resume();
      await scenario.tick(2);
      expect(pauses(scenario.commands)).toHaveLength(1);
      expect(scenario.logs("Scenario")).toEqual(["begin", "a", "b", "a", "b", "a", "b", "a", "b"]);
    } finally { scenario.stop(); }
  });

  it("never stop a release export", async () => {
    const scenario = await startGraphScenario({
      scripts: [heroScript({ instrumentBreakpoints: true, stripDevelopmentOnly: true })],
      actors: heroes.slice(0, 1),
      runtime: { breakpoints: [at("logA")] },
    });
    try {
      await scenario.tick(2);
      expect(pauses(scenario.commands)).toEqual([]);
      expect(scenario.logs("Scenario")).toEqual(["begin", "a", "b", "a", "b"]);
    } finally { scenario.stop(); }
  });
});

describe("Behaviour Tree breakpoints", () => {
  type BtNode = BehaviourTreeDocument["nodes"][number];
  const btNode = (id: string, kind: BtNode["kind"], classId: string, children: string[] = []): BtNode =>
    ({ id, kind, classId, children, decorators: [], services: [], properties: {} });

  it("stop when a tree node fails, naming the tree's component and its actor", async () => {
    const blocked = btNode("blocked", "task", "bt.task.succeed");
    blocked.decorators.push({
      id: "need", classId: "bt.decorator.blackboardIsSet", abortMode: "none", observedKeys: ["target"], properties: { key: "target" },
    });
    const wait = { ...btNode("wait", "task", "bt.task.wait"), properties: { durationMs: 10_000 } };
    const guard = createActor("guard", "Guard", {
      components: [{ id: "bt-1", classId: "BehaviourTreeComponent", properties: { treeGuid: "tree-1" } }],
    });
    const scenario = await startGraphScenario({
      scripts: [],
      actors: [guard],
      runtime: {
        behaviourTrees: { "tree-1": {
          name: "Patrol", rootId: "root", blackboardGuid: null,
          nodes: [btNode("root", "selector", "bt.composite.selector", ["blocked", "wait"]), blocked, wait],
        } },
        breakpoints: [{ assetGuid: "tree-1", graphId: BT_DEBUG_GRAPH_ID, nodeId: "blocked" }],
      },
    });
    try {
      await scenario.tick();
      const component = scenario.runtime.getWorld().getActors().find((actor) => actor.guid === "guard")!.components[0]!;
      expect(pauses(scenario.commands)).toEqual([{
        code: BREAKPOINT_PAUSE_CODE, message: "Breakpoint", assetGuid: "tree-1", graphId: BT_DEBUG_GRAPH_ID,
        nodeId: "blocked", instanceId: component.guid, instanceLabel: "Guard", breakpointEvent: "failed",
      }]);
    } finally { scenario.stop(); }
  });
});
