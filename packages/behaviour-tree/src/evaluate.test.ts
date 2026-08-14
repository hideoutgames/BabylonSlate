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

  it("restarts a completed Wait from zero on the next tree cycle", () => {
    const wait = node("wait", "task", "bt.task.wait");
    wait.properties = { durationMs: 100 };
    const doc = tree([wait], "wait");
    const running = evaluateBehaviourTree(doc, null, 0.05);
    expect(running.status).toBe("running");
    const done = evaluateBehaviourTree(doc, running, 0.06);
    expect(done.status).toBe("success");
    expect(done.stack).toEqual([]);
    const again = evaluateBehaviourTree(doc, done, 0.05);
    expect(again.status).toBe("running");
    expect(again.btNodeId).toBe("wait");
  });

  it("clears MoveTo host memory so the next cycle requests again", () => {
    const leaf = node("move", "task", "BTTask_MoveTo");
    const doc = tree([leaf], "move");
    const host = {
      tick: (
        _node: { id: string },
        _blackboard: Record<string, unknown>,
        _dt: number,
        memory: Record<string, unknown>,
      ) => {
        if (memory.__moveRequested === true) return "success" as const;
        memory.__moveRequested = true;
        return "running" as const;
      },
    };
    const running = evaluateBehaviourTree(doc, null, 1 / 60, { host });
    expect(running.status).toBe("running");
    const done = evaluateBehaviourTree(doc, running, 1 / 60, { host });
    expect(done.status).toBe("success");
    const again = evaluateBehaviourTree(doc, done, 1 / 60, { host });
    expect(again.status).toBe("running");
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

  it("succeeds a MoveTo stub without a navmesh", () => {
    const leaf = node("move", "task", "BTTask_MoveTo");
    const doc = tree(
      [node("root", "sequence", "bt.composite.sequence", ["move"]), leaf],
      "root",
    );
    expect(evaluateBehaviourTree(doc, null, 1 / 60).status).toBe("success");
  });

  it("runs MoveTo through the task host when one is provided", () => {
    const leaf = node("move", "task", "BTTask_MoveTo");
    leaf.properties = { destination: { x: 4, y: 0, z: 4 } };
    const doc = tree(
      [node("root", "sequence", "bt.composite.sequence", ["move"]), leaf],
      "root",
    );
    let ticks = 0;
    const first = evaluateBehaviourTree(doc, null, 1 / 60, {
      host: {
        tick: () => {
          ticks += 1;
          return ticks >= 2 ? "success" : "running";
        },
      },
    });
    expect(first.status).toBe("running");
    const second = evaluateBehaviourTree(doc, first, 1 / 60, {
      host: {
        tick: () => {
          ticks += 1;
          return ticks >= 2 ? "success" : "running";
        },
      },
    });
    expect(second.status).toBe("success");
    expect(ticks).toBe(2);
  });

  it("compares a blackboard value on a decorator", () => {
    const leaf = node("leaf", "task", "bt.task.succeed");
    leaf.decorators.push({
      id: "need",
      classId: "BTDecorator_CompareBlackboardValue",
      abortMode: "none",
      observedKeys: ["hp"],
      properties: { key: "hp", op: "gte", value: 10 },
    });
    const doc = tree(
      [node("root", "sequence", "bt.composite.sequence", ["leaf"]), leaf],
      "root",
    );
    expect(
      evaluateBehaviourTree(doc, null, 1 / 60, { blackboard: { hp: 4 } }).status,
    ).toBe("failure");
    expect(
      evaluateBehaviourTree(doc, null, 1 / 60, { blackboard: { hp: 10 } }).status,
    ).toBe("success");
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

  it("fires an attached setBlackboard service while a wait stays running", () => {
    const root = node("root", "sequence", "bt.composite.sequence", ["idle"]);
    root.services.push({
      id: "pulse",
      classId: "bt.service.setBlackboard",
      intervalMs: 50,
      randomDeviationMs: 0,
      properties: { key: "alert", value: true },
    });
    const wait = node("idle", "task", "bt.task.wait");
    wait.properties = { durationMs: 10_000 };
    const doc = tree([root, wait], "root");
    const first = evaluateBehaviourTree(doc, null, 0.03, { blackboard: {} });
    expect(first.status).toBe("running");
    expect(first.blackboard.alert).toBeUndefined();
    const second = evaluateBehaviourTree(doc, first, 0.03, { blackboard: first.blackboard });
    expect(second.status).toBe("running");
    expect(second.blackboard.alert).toBe(true);
  });

  it("lets an unknown decorator class pass when no decorator host is provided", () => {
    const leaf = node("leaf", "task", "bt.task.succeed");
    leaf.decorators.push({
      id: "custom",
      classId: "BTDecorator_Alert",
      abortMode: "none",
      observedKeys: [],
      properties: {},
    });
    const doc = tree(
      [node("root", "sequence", "bt.composite.sequence", ["leaf"]), leaf],
      "root",
    );
    expect(evaluateBehaviourTree(doc, null, 1 / 60).status).toBe("success");
  });

  it("fails a wait when a custom decorator host returns false", () => {
    const wait = node("wait", "task", "bt.task.wait");
    wait.properties = { durationMs: 10_000 };
    wait.decorators.push({
      id: "gate",
      classId: "BTDecorator_Alert",
      abortMode: "none",
      observedKeys: [],
      properties: {},
    });
    const doc = tree(
      [node("root", "sequence", "bt.composite.sequence", ["wait"]), wait],
      "root",
    );
    const next = evaluateBehaviourTree(doc, null, 0.016, {
      decoratorHost: { evaluate: () => false },
    });
    expect(next.status).toBe("failure");
    expect(next.stack).toEqual([]);
  });

  it("notifies the task host abort when a self-abort pops a running wait", () => {
    const root = node("root", "sequence", "bt.composite.sequence", ["idle"]);
    root.decorators.push({
      id: "alive",
      classId: "bt.decorator.blackboardIsSet",
      abortMode: "self",
      observedKeys: ["ok"],
      properties: { key: "ok" },
    });
    const wait = node("idle", "task", "bt.task.wait");
    wait.properties = { durationMs: 10_000 };
    const doc = tree([root, wait], "root");
    const aborted: string[] = [];
    const host = {
      tick: () => "running" as const,
      abort: (entry: { id: string }) => {
        aborted.push(entry.id);
      },
    };
    const running = evaluateBehaviourTree(doc, null, 0.016, {
      blackboard: { ok: true },
      host,
    });
    expect(running.status).toBe("running");
    expect(aborted).toEqual([]);
    const next = evaluateBehaviourTree(doc, running, 0.016, {
      blackboard: {},
      host,
    });
    expect(next.status).toBe("failure");
    expect(aborted).toEqual(["idle"]);
  });

  it("ticks a custom service through the service host", () => {
    const root = node("root", "sequence", "bt.composite.sequence", ["idle"]);
    root.services.push({
      id: "custom",
      classId: "bt.service.custom",
      intervalMs: 0,
      randomDeviationMs: 0,
      properties: {},
    });
    const wait = node("idle", "task", "bt.task.wait");
    wait.properties = { durationMs: 10_000 };
    const doc = tree([root, wait], "root");
    const seen: string[] = [];
    const next = evaluateBehaviourTree(doc, null, 1 / 60, {
      serviceHost: {
        tick: (service) => {
          seen.push(service.id);
        },
      },
    });
    expect(next.status).toBe("running");
    expect(seen).toEqual(["custom"]);
  });

  it("does not tick a service after abort pops its owner", () => {
    const root = node("root", "sequence", "bt.composite.sequence", ["idle"]);
    root.decorators.push({
      id: "alive",
      classId: "bt.decorator.blackboardIsSet",
      abortMode: "self",
      observedKeys: ["ok"],
      properties: { key: "ok" },
    });
    root.services.push({
      id: "pulse",
      classId: "bt.service.custom",
      intervalMs: 0,
      randomDeviationMs: 0,
      properties: {},
    });
    const wait = node("idle", "task", "bt.task.wait");
    wait.properties = { durationMs: 10_000 };
    const doc = tree([root, wait], "root");
    const seen: string[] = [];
    const host = {
      tick: (service: { id: string }) => {
        seen.push(service.id);
      },
    };
    const running = evaluateBehaviourTree(doc, null, 0.016, {
      blackboard: { ok: true },
      serviceHost: host,
    });
    expect(running.status).toBe("running");
    expect(seen).toEqual(["pulse"]);
    const aborted = evaluateBehaviourTree(doc, running, 0.016, {
      blackboard: {},
      serviceHost: host,
    });
    expect(aborted.status).toBe("failure");
    expect(seen).toEqual(["pulse"]);
  });

  it("loops a succeeding task a finite number of times", () => {
    const leaf = node("leaf", "task", "bt.task.custom");
    leaf.decorators.push({
      id: "loop",
      classId: "bt.decorator.loop",
      abortMode: "none",
      observedKeys: [],
      properties: { numLoops: 3 },
    });
    const doc = tree(
      [node("root", "sequence", "bt.composite.sequence", ["leaf"]), leaf],
      "root",
    );
    let ticks = 0;
    const next = evaluateBehaviourTree(doc, null, 1 / 60, {
      host: {
        tick: () => {
          ticks += 1;
          return "success";
        },
      },
    });
    expect(next.status).toBe("success");
    expect(ticks).toBe(3);
  });

  it("blocks a node during cooldown after it finishes", () => {
    const leaf = node("leaf", "task", "bt.task.succeed");
    leaf.decorators.push({
      id: "cd",
      classId: "bt.decorator.cooldown",
      abortMode: "none",
      observedKeys: [],
      properties: { durationMs: 100 },
    });
    const doc = tree(
      [node("root", "selector", "bt.composite.selector", ["leaf"]), leaf],
      "root",
    );
    const first = evaluateBehaviourTree(doc, null, 1 / 60);
    expect(first.status).toBe("success");
    const cooling = evaluateBehaviourTree(doc, first, 0.05);
    expect(cooling.status).toBe("failure");
    const ready = evaluateBehaviourTree(doc, cooling, 0.06);
    expect(ready.status).toBe("success");
  });

  it("fails a running node when its time limit elapses", () => {
    const wait = node("wait", "task", "bt.task.wait");
    wait.properties = { durationMs: 10_000 };
    wait.decorators.push({
      id: "limit",
      classId: "bt.decorator.timeLimit",
      abortMode: "none",
      observedKeys: [],
      properties: { durationMs: 80 },
    });
    const doc = tree(
      [node("root", "sequence", "bt.composite.sequence", ["wait"]), wait],
      "root",
    );
    const running = evaluateBehaviourTree(doc, null, 0.05);
    expect(running.status).toBe("running");
    const timedOut = evaluateBehaviourTree(doc, running, 0.05);
    expect(timedOut.status).toBe("failure");
    expect(timedOut.stack).toEqual([]);
  });

  it("reproduces the same service schedule for the same seed", () => {
    const root = node("root", "sequence", "bt.composite.sequence", ["idle"]);
    root.services.push({
      id: "pulse",
      classId: "bt.service.setBlackboard",
      intervalMs: 40,
      randomDeviationMs: 20,
      properties: { key: "count", value: 1 },
    });
    const wait = node("idle", "task", "bt.task.wait");
    wait.properties = { durationMs: 10_000 };
    const doc = tree([root, wait], "root");
    const run = (seed: number) => {
      let state = evaluateBehaviourTree(doc, null, 0.016, { seed, blackboard: {} });
      for (let i = 0; i < 12; i += 1) {
        state = evaluateBehaviourTree(doc, state, 0.016, { seed, blackboard: state.blackboard });
      }
      return state;
    };
    const a = run(7);
    const b = run(7);
    expect(a.blackboard.count).toBe(1);
    expect(a).toEqual(b);
  });
});
