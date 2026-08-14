import { describe, expect, it } from "vitest";
import {
  evaluateBehaviourTree,
  type BehaviourTreeDocument,
  type BtAbortMode,
  type BtEvalState,
  type BtNode,
  type BtResult,
} from "./index";

function node(
  id: string,
  kind: BtNode["kind"],
  classId: string,
  children: string[] = [],
): BtNode {
  return {
    id,
    kind,
    classId,
    children,
    decorators: [],
    services: [],
    properties: {},
  };
}

function patrolTree(abortMode: BtAbortMode): BehaviourTreeDocument {
  const high = node("high", "sequence", "bt.composite.sequence", ["poke"]);
  high.decorators.push({
    id: "watch",
    classId: "bt.decorator.blackboardIsSet",
    abortMode,
    observedKeys: ["alert"],
    properties: { key: "alert" },
  });
  const wait = node("idle", "task", "bt.task.wait");
  wait.properties = { durationMs: 10_000 };
  return {
    name: "Abort",
    rootId: "root",
    blackboardGuid: null,
    nodes: [
      node("root", "selector", "bt.composite.selector", ["high", "low"]),
      high,
      node("poke", "task", "bt.task.succeed"),
      node("low", "sequence", "bt.composite.sequence", ["idle"]),
      wait,
    ],
  };
}

function guardedWait(abortMode: BtAbortMode): BehaviourTreeDocument {
  const root = node("root", "sequence", "bt.composite.sequence", ["idle"]);
  root.decorators.push({
    id: "alive",
    classId: "bt.decorator.blackboardIsSet",
    abortMode,
    observedKeys: ["ok"],
    properties: { key: "ok" },
  });
  const wait = node("idle", "task", "bt.task.wait");
  wait.properties = { durationMs: 10_000 };
  return {
    name: "Self",
    rootId: "root",
    blackboardGuid: null,
    nodes: [root, wait],
  };
}

type Case = {
  name: string;
  tree: BehaviourTreeDocument;
  ticks: Array<{ dt: number; blackboard: Record<string, unknown> }>;
  expectStatus: BtResult;
  expectRunning?: string;
};

const MATRIX: Case[] = [
  {
    name: "lowerPriority: idle runs while alert is unset",
    tree: patrolTree("lowerPriority"),
    ticks: [{ dt: 0.016, blackboard: {} }],
    expectStatus: "running",
    expectRunning: "idle",
  },
  {
    name: "lowerPriority: alert aborts the rightward wait and runs high",
    tree: patrolTree("lowerPriority"),
    ticks: [
      { dt: 0.016, blackboard: {} },
      { dt: 0.016, blackboard: { alert: true } },
    ],
    expectStatus: "success",
  },
  {
    name: "none: alert does not abort the running lower sibling",
    tree: patrolTree("none"),
    ticks: [
      { dt: 0.016, blackboard: {} },
      { dt: 0.016, blackboard: { alert: true } },
    ],
    expectStatus: "running",
    expectRunning: "idle",
  },
  {
    name: "self: wait runs while ok is set",
    tree: guardedWait("self"),
    ticks: [{ dt: 0.016, blackboard: { ok: true } }],
    expectStatus: "running",
    expectRunning: "idle",
  },
  {
    name: "self: clearing ok aborts the decorated sequence",
    tree: guardedWait("self"),
    ticks: [
      { dt: 0.016, blackboard: { ok: true } },
      { dt: 0.016, blackboard: {} },
    ],
    expectStatus: "failure",
  },
  {
    name: "both: lowerPriority abort still fires on a selector child",
    tree: patrolTree("both"),
    ticks: [
      { dt: 0.016, blackboard: {} },
      { dt: 0.016, blackboard: { alert: true } },
    ],
    expectStatus: "success",
  },
  {
    name: "both: self abort still fires on the decorated node",
    tree: guardedWait("both"),
    ticks: [
      { dt: 0.016, blackboard: { ok: true } },
      { dt: 0.016, blackboard: {} },
    ],
    expectStatus: "failure",
  },
];

function runCase(entry: Case): BtEvalState {
  let state: BtEvalState | null = null;
  for (const tick of entry.ticks) {
    state = evaluateBehaviourTree(entry.tree, state, tick.dt, {
      blackboard: tick.blackboard,
    });
  }
  return state!;
}

describe("behaviour tree abort matrix", () => {
  it.each(MATRIX)("$name", (entry) => {
    const state = runCase(entry);
    expect(state.status).toBe(entry.expectStatus);
    if (entry.expectRunning) {
      expect(state.btNodeId).toBe(entry.expectRunning);
    } else {
      expect(state.stack).toEqual([]);
    }
  });
});
