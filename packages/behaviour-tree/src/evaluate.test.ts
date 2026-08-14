import { describe, expect, it } from "vitest";
import {
  createDefaultBehaviourTree,
  evaluateBehaviourTree,
  type BehaviourTreeDocument,
  type BtNode,
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

function tree(nodes: BtNode[], rootId: string): BehaviourTreeDocument {
  return { name: "Test", rootId, nodes, blackboardGuid: null };
}

describe("evaluateBehaviourTree", () => {
  it("succeeds a default tree in one tick", () => {
    const next = evaluateBehaviourTree(createDefaultBehaviourTree(), null, 1 / 60);
    expect(next.status).toBe("success");
    expect(next.stack).toEqual([]);
    expect(next.btNodeId).toBeNull();
  });

  it("runs a sequence until a child fails", () => {
    const doc = tree(
      [
        node("root", "sequence", "bt.composite.sequence", ["ok", "no"]),
        node("ok", "task", "bt.task.succeed"),
        node("no", "task", "bt.task.fail"),
      ],
      "root",
    );
    const next = evaluateBehaviourTree(doc, null, 1 / 60);
    expect(next.status).toBe("failure");
    expect(next.lastResults.ok).toBe("success");
    expect(next.lastResults.no).toBe("failure");
  });

  it("selects the first succeeding child", () => {
    const doc = tree(
      [
        node("root", "selector", "bt.composite.selector", ["no", "ok"]),
        node("no", "task", "bt.task.fail"),
        node("ok", "task", "bt.task.succeed"),
      ],
      "root",
    );
    const next = evaluateBehaviourTree(doc, null, 1 / 60);
    expect(next.status).toBe("success");
    expect(next.lastResults.no).toBe("failure");
    expect(next.lastResults.ok).toBe("success");
  });

  it("keeps a wait task running across ticks then succeeds", () => {
    const wait = node("wait", "task", "bt.task.wait");
    wait.properties = { durationMs: 100 };
    const doc = tree([node("root", "sequence", "bt.composite.sequence", ["wait"]), wait], "root");
    const a = evaluateBehaviourTree(doc, null, 0.05);
    expect(a.status).toBe("running");
    expect(a.btNodeId).toBe("wait");
    expect(a.stack.some((frame) => frame.nodeId === "wait")).toBe(true);
    const b = evaluateBehaviourTree(doc, a, 0.06);
    expect(b.status).toBe("success");
    expect(b.stack).toEqual([]);
  });

  it("ticks every parallel child and fails if any fail", () => {
    const doc = tree(
      [
        node("root", "parallel", "bt.composite.parallel", ["ok", "no"]),
        node("ok", "task", "bt.task.succeed"),
        node("no", "task", "bt.task.fail"),
      ],
      "root",
    );
    const next = evaluateBehaviourTree(doc, null, 1 / 60);
    expect(next.status).toBe("failure");
    expect(next.lastResults.ok).toBe("success");
    expect(next.lastResults.no).toBe("failure");
  });

  it("writes a blackboard key from a set task", () => {
    const set = node("set", "task", "bt.task.setBlackboard");
    set.properties = { key: "alert", value: true };
    const doc = tree([node("root", "sequence", "bt.composite.sequence", ["set"]), set], "root");
    const next = evaluateBehaviourTree(doc, null, 1 / 60, { blackboard: {} });
    expect(next.status).toBe("success");
    expect(next.blackboard.alert).toBe(true);
  });

  it("reproduces the same eval state for the same inputs", () => {
    const wait = node("wait", "task", "bt.task.wait");
    wait.properties = { durationMs: 1000 };
    const doc = tree([node("root", "selector", "bt.composite.selector", ["wait"]), wait], "root");
    const a = evaluateBehaviourTree(doc, null, 0.016);
    const b = evaluateBehaviourTree(doc, null, 0.016);
    expect(a).toEqual(b);
  });

  it("steps a deep succeed chain without overflowing", () => {
    const tasks: BtNode[] = [];
    const ids: string[] = [];
    for (let i = 0; i < 64; i += 1) {
      const id = `t${i}`;
      ids.push(id);
      tasks.push(node(id, "task", "bt.task.succeed"));
    }
    const doc = tree(
      [node("root", "sequence", "bt.composite.sequence", ids), ...tasks],
      "root",
    );
    expect(evaluateBehaviourTree(doc, null, 1 / 60).status).toBe("success");
  });

  it("fails a composite whose child id is missing", () => {
    const doc = tree([node("root", "sequence", "bt.composite.sequence", ["gone"])], "root");
    const next = evaluateBehaviourTree(doc, null, 1 / 60);
    expect(next.status).toBe("failure");
    expect(next.stack).toEqual([]);
  });

  it("fails an unknown task class when no host is provided", () => {
    const leaf = node("leaf", "task", "bt.task.custom");
    const doc = tree(
      [node("root", "sequence", "bt.composite.sequence", ["leaf"]), leaf],
      "root",
    );
    expect(evaluateBehaviourTree(doc, null, 1 / 60).status).toBe("failure");
  });

  it("ticks a custom task through the host", () => {
    const leaf = node("leaf", "task", "bt.task.custom");
    const doc = tree(
      [node("root", "sequence", "bt.composite.sequence", ["leaf"]), leaf],
      "root",
    );
    const next = evaluateBehaviourTree(doc, null, 1 / 60, {
      host: { tick: () => "success" },
    });
    expect(next.status).toBe("success");
  });

  it("fails a decorated task when the blackboard condition is unset", () => {
    const leaf = node("leaf", "task", "bt.task.succeed");
    leaf.decorators.push({
      id: "need",
      classId: "bt.decorator.blackboardIsSet",
      abortMode: "none",
      observedKeys: ["flag"],
      properties: { key: "flag" },
    });
    const doc = tree(
      [node("root", "sequence", "bt.composite.sequence", ["leaf"]), leaf],
      "root",
    );
    expect(evaluateBehaviourTree(doc, null, 1 / 60, { blackboard: {} }).status).toBe(
      "failure",
    );
  });

  it("fails a decorated node when the blackboard condition is unset", () => {
    const root = node("root", "sequence", "bt.composite.sequence", ["ok"]);
    root.decorators.push({
      id: "need",
      classId: "bt.decorator.blackboardIsSet",
      abortMode: "none",
      observedKeys: ["flag"],
      properties: { key: "flag" },
    });
    const doc = tree([root, node("ok", "task", "bt.task.succeed")], "root");
    const next = evaluateBehaviourTree(doc, null, 1 / 60, { blackboard: {} });
    expect(next.status).toBe("failure");
    expect(next.lastResults.root).toBe("failure");
  });

  it("succeeds a parallel when every child succeeds", () => {
    const doc = tree(
      [
        node("root", "parallel", "bt.composite.parallel", ["a", "b"]),
        node("a", "task", "bt.task.succeed"),
        node("b", "task", "bt.task.succeed"),
      ],
      "root",
    );
    const next = evaluateBehaviourTree(doc, null, 1 / 60);
    expect(next.status).toBe("success");
    expect(next.lastResults.a).toBe("success");
    expect(next.lastResults.b).toBe("success");
  });

  it("ticks every parallel wait then succeeds when all complete", () => {
    const a = node("a", "task", "bt.task.wait");
    a.properties = { durationMs: 100 };
    const b = node("b", "task", "bt.task.wait");
    b.properties = { durationMs: 100 };
    const doc = tree(
      [node("root", "parallel", "bt.composite.parallel", ["a", "b"]), a, b],
      "root",
    );
    const first = evaluateBehaviourTree(doc, null, 0.05);
    expect(first.status).toBe("running");
    const second = evaluateBehaviourTree(doc, first, 0.06);
    expect(second.status).toBe("success");
    expect(second.stack).toEqual([]);
  });

  it("fails a selector when every child fails", () => {
    const doc = tree(
      [
        node("root", "selector", "bt.composite.selector", ["a", "b"]),
        node("a", "task", "bt.task.fail"),
        node("b", "task", "bt.task.fail"),
      ],
      "root",
    );
    expect(evaluateBehaviourTree(doc, null, 1 / 60).status).toBe("failure");
  });

  it("succeeds a zero-duration wait on the first tick", () => {
    const wait = node("wait", "task", "bt.task.wait");
    wait.properties = { durationMs: 0 };
    const doc = tree(
      [node("root", "sequence", "bt.composite.sequence", ["wait"]), wait],
      "root",
    );
    expect(evaluateBehaviourTree(doc, null, 1 / 60).status).toBe("success");
  });
});
