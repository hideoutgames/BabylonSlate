import { describe, expect, it } from "vitest";
import { types } from "node:util";
import {
  createDefaultBehaviourTree,
  evaluateBehaviourTree,
  type BehaviourTreeDocument,
  type BtDecorator,
  type BtEvalState,
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

  it("evaluates a replaced document from its own structure", () => {
    const doc = tree(
      [
        node("root", "sequence", "bt.composite.sequence", ["ok", "no"]),
        node("ok", "task", "bt.task.succeed"),
        node("no", "task", "bt.task.fail"),
      ],
      "root",
    );
    expect(evaluateBehaviourTree(doc, null, 1 / 60).status).toBe("failure");
    const edited = {
      ...doc,
      nodes: doc.nodes.map((row) => (row.id === "root" ? { ...row, children: ["ok"] } : row)),
    };
    const next = evaluateBehaviourTree(edited, null, 1 / 60);
    expect(next.status).toBe("success");
    expect(next.lastResults.no).toBeUndefined();
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

  it("ticks Play Sound through the host when one is provided", () => {
    const leaf = node("sound", "task", "bt.task.playSound");
    leaf.properties = { audioAssetGuid: "audio-1", volume: 0.5 };
    const doc = tree([leaf], "sound");
    const ticks: string[] = [];
    const next = evaluateBehaviourTree(doc, null, 1 / 60, {
      host: {
        tick: (task) => {
          ticks.push(task.classId);
          return "success";
        },
      },
    });
    expect(ticks).toEqual(["bt.task.playSound"]);
    expect(next.status).toBe("success");
  });

  it("ticks Rotate To Face and Play Animation through the host when one is provided", () => {
    const rotate = node("face", "task", "bt.task.rotateToFace");
    rotate.properties = { target: { x: 1, y: 0, z: 0 } };
    const anim = node("anim", "task", "bt.task.playAnimation");
    anim.properties = { clipKind: "animation", clipAssetGuid: "walk-1" };
    const ticks: string[] = [];
    const host = {
      tick: (task: { classId: string }) => {
        ticks.push(task.classId);
        return "success" as const;
      },
    };
    expect(
      evaluateBehaviourTree(tree([rotate], "face"), null, 1 / 60, { host }).status,
    ).toBe("success");
    expect(
      evaluateBehaviourTree(tree([anim], "anim"), null, 1 / 60, { host }).status,
    ).toBe("success");
    expect(ticks).toEqual(["bt.task.rotateToFace", "bt.task.playAnimation"]);
  });

  it("succeeds Rotate To Face and Play Animation without a host", () => {
    expect(
      evaluateBehaviourTree(
        tree([node("face", "task", "bt.task.rotateToFace")], "face"),
        null,
        1 / 60,
      ).status,
    ).toBe("success");
    expect(
      evaluateBehaviourTree(
        tree([node("anim", "task", "bt.task.playAnimation")], "anim"),
        null,
        1 / 60,
      ).status,
    ).toBe("success");
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

  it("drops a child reference that loops back, so abort walks end at the root", () => {
    const a = node("a", "sequence", "bt.composite.sequence", ["b"]);
    a.decorators.push({
      id: "watch",
      classId: "bt.decorator.blackboardIsSet",
      abortMode: "lowerPriority",
      observedKeys: ["k"],
      properties: { key: "k" },
    });
    const wait = node("wait", "task", "bt.task.wait");
    wait.properties = { durationMs: 1000 };
    const doc = tree(
      [
        node("root", "sequence", "bt.composite.sequence", ["a"]),
        a,
        node("b", "sequence", "bt.composite.sequence", ["a", "wait"]),
        wait,
      ],
      "root",
    );
    const first = evaluateBehaviourTree(doc, null, 0.016, { blackboard: { k: true } });
    expect(first.btNodeId).toBe("wait");
    const next = evaluateBehaviourTree(doc, first, 0.016, { blackboard: { k: true } });
    expect(next.status).toBe("running");
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

  it("succeeds a parallel with no children, like an empty sequence", () => {
    const doc = tree([node("root", "parallel", "bt.composite.parallel")], "root");
    const next = evaluateBehaviourTree(doc, null, 1 / 60);
    expect(next.status).toBe("success");
    expect(next.stack).toEqual([]);
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

  it.each([
    { op: "eq", z: 3, want: "success" },
    { op: "eq", z: 4, want: "failure" },
    { op: "neq", z: 3, want: "failure" },
    { op: "neq", z: 4, want: "success" },
  ])("compares a vec3 blackboard value by its components ($op, z $z)", ({ op, z, want }) => {
    const leaf = node("leaf", "task", "bt.task.succeed");
    leaf.decorators.push({
      id: "at",
      classId: "BTDecorator_CompareBlackboardValue",
      abortMode: "none",
      observedKeys: ["target"],
      properties: { key: "target", op, value: { x: 1, y: 2, z } },
    });
    const doc = tree(
      [node("root", "sequence", "bt.composite.sequence", ["leaf"]), leaf],
      "root",
    );
    const blackboard = { target: { x: 1, y: 2, z: 3 } };
    expect(evaluateBehaviourTree(doc, null, 1 / 60, { blackboard }).status).toBe(want);
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

  it("keeps a child's cooldown when a Loop restarts its subtree", () => {
    const leaf = node("leaf", "task", "bt.task.custom");
    leaf.decorators.push({
      id: "cd",
      classId: "bt.decorator.cooldown",
      abortMode: "none",
      observedKeys: [],
      properties: { durationMs: 1000 },
    });
    const body = node("body", "sequence", "bt.composite.sequence", ["leaf"]);
    body.decorators.push({
      id: "loop",
      classId: "bt.decorator.loop",
      abortMode: "none",
      observedKeys: [],
      properties: { numLoops: 3 },
    });
    const doc = tree(
      [node("root", "sequence", "bt.composite.sequence", ["body"]), body, leaf],
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
    // Iterations two and three meet the cooldown the first one started.
    expect(ticks).toBe(1);
    expect(next.status).toBe("failure");
  });

  it("fires a service at most once on a long tick", () => {
    const root = node("root", "sequence", "bt.composite.sequence", ["idle"]);
    root.services.push({
      id: "pulse",
      classId: "bt.service.custom",
      intervalMs: 50,
      randomDeviationMs: 0,
      properties: {},
    });
    const wait = node("idle", "task", "bt.task.wait");
    wait.properties = { durationMs: 10_000 };
    const doc = tree([root, wait], "root");
    const seen: string[] = [];
    const host = { tick: (service: { id: string }) => seen.push(service.id) };
    const hitch = evaluateBehaviourTree(doc, null, 1, { serviceHost: host });
    expect(hitch.status).toBe("running");
    expect(seen).toEqual(["pulse"]);
    // The missed intervals are dropped, not replayed on the next short tick.
    evaluateBehaviourTree(doc, hitch, 0.016, { serviceHost: host });
    expect(seen).toEqual(["pulse"]);
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

  it("does not restart a root TimeLimit failure until the next tick", () => {
    const wait = node("wait", "task", "bt.task.wait");
    wait.properties = { durationMs: 10_000 };
    wait.decorators.push({
      id: "limit",
      classId: "bt.decorator.timeLimit",
      abortMode: "none",
      observedKeys: [],
      properties: { durationMs: 80 },
    });
    const doc = tree([wait], "wait");
    const running = evaluateBehaviourTree(doc, null, 0.05);
    expect(running.status).toBe("running");
    const timedOut = evaluateBehaviourTree(doc, running, 0.05);
    expect(timedOut.status).toBe("failure");
    expect(timedOut.stack).toEqual([]);
    const again = evaluateBehaviourTree(doc, timedOut, 0.05);
    expect(again.status).toBe("running");
  });

  it("ticks a nested parallel sibling while a sequence child is running", () => {
    const wait = node("wait", "task", "bt.task.wait");
    wait.properties = { durationMs: 100 };
    const doc = tree(
      [
        node("root", "parallel", "bt.composite.parallel", ["seq", "other"]),
        node("seq", "sequence", "bt.composite.sequence", ["wait"]),
        wait,
        node("other", "task", "bt.task.succeed"),
      ],
      "root",
    );
    const next = evaluateBehaviourTree(doc, null, 0.05);
    expect(next.status).toBe("running");
    expect(next.lastResults.wait).toBe("running");
    expect(next.lastResults.other).toBe("success");
  });

  it("advances TimeLimit on a running parallel child", () => {
    const wait = node("wait", "task", "bt.task.wait");
    wait.properties = { durationMs: 10_000 };
    wait.decorators.push({
      id: "limit",
      classId: "bt.decorator.timeLimit",
      abortMode: "none",
      observedKeys: [],
      properties: { durationMs: 80 },
    });
    const idle = node("idle", "task", "bt.task.wait");
    idle.properties = { durationMs: 10_000 };
    const doc = tree(
      [node("root", "parallel", "bt.composite.parallel", ["wait", "idle"]), wait, idle],
      "root",
    );
    const running = evaluateBehaviourTree(doc, null, 0.05);
    expect(running.status).toBe("running");
    const timedOut = evaluateBehaviourTree(doc, running, 0.05);
    expect(timedOut.status).toBe("failure");
    expect(timedOut.lastResults.wait).toBe("failure");
    expect(timedOut.stack).toEqual([]);
  });

  it("aborts a running parallel sibling when another child fails", () => {
    const aborted: string[] = [];
    const runner = node("runner", "task", "bt.task.custom");
    const doc = tree(
      [
        node("root", "parallel", "bt.composite.parallel", ["runner", "no"]),
        runner,
        node("no", "task", "bt.task.fail"),
      ],
      "root",
    );
    const next = evaluateBehaviourTree(doc, null, 1 / 60, {
      host: {
        tick: () => "running",
        abort: (leaf) => {
          aborted.push(leaf.id);
        },
      },
    });
    expect(next.status).toBe("failure");
    expect(aborted).toEqual(["runner"]);
  });

  it("ticks services on a running parallel child each step", () => {
    const wait = node("wait", "task", "bt.task.wait");
    wait.properties = { durationMs: 10_000 };
    wait.services.push({
      id: "pulse",
      classId: "bt.service.custom",
      intervalMs: 0,
      randomDeviationMs: 0,
      properties: {},
    });
    const idle = node("idle", "task", "bt.task.wait");
    idle.properties = { durationMs: 10_000 };
    const doc = tree(
      [node("root", "parallel", "bt.composite.parallel", ["wait", "idle"]), wait, idle],
      "root",
    );
    const seen: string[] = [];
    const host = { tick: (service: { id: string }) => seen.push(service.id) };
    const first = evaluateBehaviourTree(doc, null, 0.016, { serviceHost: host });
    expect(first.status).toBe("running");
    evaluateBehaviourTree(doc, first, 0.016, { serviceHost: host });
    expect(seen).toEqual(["pulse", "pulse"]);
  });

  it("loops a failing task until numLoops", () => {
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
          return "failure";
        },
      },
    });
    expect(next.status).toBe("failure");
    expect(ticks).toBe(3);
  });

  it("restarts an infinite Loop at most once per tick and re-checks its decorators", () => {
    const leaf = node("leaf", "task", "bt.task.custom");
    leaf.decorators.push(
      {
        id: "loop",
        classId: "bt.decorator.loop",
        abortMode: "none",
        observedKeys: [],
        properties: { numLoops: 0 },
      },
      {
        id: "go",
        classId: "bt.decorator.blackboardIsSet",
        abortMode: "none",
        observedKeys: ["go"],
        properties: { key: "go" },
      },
    );
    const doc = tree(
      [node("root", "sequence", "bt.composite.sequence", ["leaf"]), leaf],
      "root",
    );
    let ticks = 0;
    const host = {
      tick: () => {
        ticks += 1;
        return "success" as const;
      },
    };
    const first = evaluateBehaviourTree(doc, null, 1 / 60, { host, blackboard: { go: 1 } });
    expect(first.status).toBe("running");
    expect(ticks).toBe(2);
    const second = evaluateBehaviourTree(doc, first, 1 / 60, { host, blackboard: { go: 1 } });
    expect(ticks).toBe(4);
    // The iteration that starts on the next tick sees the decorator fail.
    const stopped = evaluateBehaviourTree(doc, second, 1 / 60, { host, blackboard: {} });
    expect(stopped.status).toBe("failure");
    expect(ticks).toBe(4);
  });

  it("stops at the smallest count when a node has several Loops", () => {
    const leaf = node("leaf", "task", "bt.task.custom");
    leaf.decorators.push(
      {
        id: "forever",
        classId: "bt.decorator.loop",
        abortMode: "none",
        observedKeys: [],
        properties: { numLoops: 0 },
      },
      {
        id: "thrice",
        classId: "bt.decorator.loop",
        abortMode: "none",
        observedKeys: [],
        properties: { numLoops: 3 },
      },
    );
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

  it("starts cooldown when a decorator aborts a running node", () => {
    const wait = node("wait", "task", "bt.task.wait");
    wait.properties = { durationMs: 10_000 };
    wait.decorators.push(
      {
        id: "alive",
        classId: "bt.decorator.blackboardIsSet",
        abortMode: "self",
        observedKeys: ["ok"],
        properties: { key: "ok" },
      },
      {
        id: "cd",
        classId: "bt.decorator.cooldown",
        abortMode: "none",
        observedKeys: [],
        properties: { durationMs: 100 },
      },
    );
    const doc = tree(
      [node("root", "sequence", "bt.composite.sequence", ["wait"]), wait],
      "root",
    );
    const running = evaluateBehaviourTree(doc, null, 0.05, {
      blackboard: { ok: true },
    });
    expect(running.status).toBe("running");
    const aborted = evaluateBehaviourTree(doc, running, 0.05, { blackboard: {} });
    expect(aborted.status).toBe("failure");
    // Like a finished node's, the cooldown counts from the next tick: the
    // abort's own frame does not shorten it.
    const cooling = evaluateBehaviourTree(doc, aborted, 0.05, {
      blackboard: { ok: true },
    });
    expect(cooling.status).toBe("failure");
    const ready = evaluateBehaviourTree(doc, cooling, 0.05, {
      blackboard: { ok: true },
    });
    expect(ready.status).toBe("running");
  });

  describe("lower-priority aborts", () => {
    function guardedPatrol(highTask: string, highDecorators: BtNode["decorators"]) {
      const high = node("high", "task", highTask);
      high.decorators.push(...highDecorators);
      return tree(
        [
          node("root", "selector", "bt.composite.selector", ["high", "low"]),
          high,
          node("low", "task", "bt.task.custom"),
        ],
        "root",
      );
    }

    function latentHost() {
      const counts = { activations: 0, aborts: 0 };
      const host = {
        tick: (
          _task: BtNode,
          _board: Record<string, unknown>,
          _dt: number,
          memory: Record<string, unknown>,
        ) => {
          if (memory.started !== true) {
            memory.started = true;
            counts.activations += 1;
          }
          return "running" as const;
        },
        abort: () => {
          counts.aborts += 1;
        },
      };
      return { counts, host };
    }

    function run(
      doc: BehaviourTreeDocument,
      host: ReturnType<typeof latentHost>["host"],
      boards: Array<Record<string, unknown>>,
    ) {
      let state = null as ReturnType<typeof evaluateBehaviourTree> | null;
      for (const blackboard of boards) {
        state = evaluateBehaviourTree(doc, state, 1 / 60, { blackboard, host });
      }
      return state!;
    }

    it("does not abort while another decorator on the higher branch fails", () => {
      const doc = guardedPatrol("bt.task.succeed", [
        {
          id: "alert",
          classId: "bt.decorator.blackboardIsSet",
          abortMode: "lowerPriority",
          observedKeys: ["alert"],
          properties: { key: "alert" },
        },
        {
          id: "armed",
          classId: "bt.decorator.blackboardIsSet",
          abortMode: "none",
          observedKeys: ["armed"],
          properties: { key: "armed" },
        },
      ]);
      const { counts, host } = latentHost();
      const state = run(doc, host, [
        { alert: false, armed: false },
        { alert: true, armed: false },
        { alert: true, armed: false },
      ]);
      expect(counts).toEqual({ activations: 1, aborts: 0 });
      expect(state.btNodeId).toBe("low");
    });

    it("aborts only when the observed condition changes to true", () => {
      const doc = guardedPatrol("bt.task.fail", [
        {
          id: "alert",
          classId: "bt.decorator.blackboardIsSet",
          abortMode: "lowerPriority",
          observedKeys: ["alert"],
          properties: { key: "alert" },
        },
      ]);
      const { counts, host } = latentHost();
      const state = run(doc, host, [
        { alert: false },
        { alert: true },
        { alert: true },
        { alert: true },
      ]);
      // One abort when alert flips; the failing high branch then hands back
      // to a fresh low activation that is not aborted again while alert stays set.
      expect(counts).toEqual({ activations: 2, aborts: 1 });
      // Clearing and setting alert again is a new change and aborts once more.
      const cleared = evaluateBehaviourTree(doc, state, 1 / 60, {
        blackboard: { alert: false },
        host,
      });
      evaluateBehaviourTree(doc, cleared, 1 / 60, { blackboard: { alert: true }, host });
      expect(counts).toEqual({ activations: 3, aborts: 2 });
    });

    it("aborts through the first parent of a node listed under two parents", () => {
      const doc = guardedPatrol("bt.task.succeed", [
        {
          id: "alert",
          classId: "bt.decorator.blackboardIsSet",
          abortMode: "lowerPriority",
          observedKeys: ["alert"],
          properties: { key: "alert" },
        },
      ]);
      doc.nodes.push(
        node("outer", "sequence", "bt.composite.sequence", ["root", "again"]),
        node("again", "selector", "bt.composite.selector", ["high"]),
      );
      doc.rootId = "outer";
      const { counts, host } = latentHost();
      run(doc, host, [{ alert: false }, { alert: true }]);
      expect(counts).toEqual({ activations: 1, aborts: 1 });
    });

    it("aborts the lower branch of a selector that yielded under a Parallel", () => {
      const high = node("high", "task", "bt.task.succeed");
      high.decorators.push({
        id: "alert",
        classId: "bt.decorator.blackboardIsSet",
        abortMode: "lowerPriority",
        observedKeys: ["alert"],
        properties: { key: "alert" },
      });
      const doc = tree(
        [
          node("root", "parallel", "bt.composite.parallel", ["pick", "idle"]),
          node("pick", "selector", "bt.composite.selector", ["high", "low"]),
          high,
          node("low", "task", "bt.task.custom"),
          node("idle", "task", "bt.task.custom"),
        ],
        "root",
      );
      const { counts, host } = latentHost();
      const first = evaluateBehaviourTree(doc, null, 1 / 60, { blackboard: { alert: false }, host });
      expect(first.lastResults.low).toBe("running");
      const next = evaluateBehaviourTree(doc, first, 1 / 60, { blackboard: { alert: true }, host });
      // The Parallel keeps running; only the selector's lower branch is aborted.
      expect(next.status).toBe("running");
      expect(next.lastResults).toMatchObject({ high: "success", pick: "success", idle: "running" });
      expect(counts.aborts).toBe(1);
    });

    it("restarts a Wait from zero when the abort re-enters it", () => {
      const doc = guardedPatrol("bt.task.fail", [
        {
          id: "alert",
          classId: "bt.decorator.blackboardIsSet",
          abortMode: "lowerPriority",
          observedKeys: ["alert"],
          properties: { key: "alert" },
        },
      ]);
      const low = doc.nodes.find((entry) => entry.id === "low")!;
      low.classId = "bt.task.wait";
      low.properties = { durationMs: 100 };
      const first = evaluateBehaviourTree(doc, null, 0.06, { blackboard: { alert: false } });
      expect(first.btNodeId).toBe("low");
      const reentered = evaluateBehaviourTree(doc, first, 0.06, { blackboard: { alert: true } });
      expect(reentered.status).toBe("running");
      expect(reentered.btNodeId).toBe("low");
      const done = evaluateBehaviourTree(doc, reentered, 0.06, { blackboard: { alert: true } });
      expect(done.status).toBe("success");
    });
  });

  it("runs each iteration of a looped Wait on its own tick", () => {
    const wait = node("wait", "task", "bt.task.wait");
    wait.properties = { durationMs: 10 };
    wait.decorators.push({
      id: "loop",
      classId: "bt.decorator.loop",
      abortMode: "none",
      observedKeys: [],
      properties: { numLoops: 100 },
    });
    const doc = tree(
      [node("root", "sequence", "bt.composite.sequence", ["wait"]), wait],
      "root",
    );
    let state = evaluateBehaviourTree(doc, null, 1 / 60);
    expect(state.status).toBe("running");
    let ticks = 1;
    while (state.status === "running" && ticks < 200) {
      state = evaluateBehaviourTree(doc, state, 1 / 60);
      ticks += 1;
    }
    expect(state.status).toBe("success");
    expect(ticks).toBe(100);
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

describe("evaluation trace", () => {
  function traced() {
    const visited: string[] = [];
    const links: string[] = [];
    return {
      visited,
      links,
      trace: { visit: (id: string) => visited.push(id), link: (parent: string, child: string) => links.push(`${parent}>${child}`) },
    };
  }
  const waiting = () => {
    const wait = node("wait", "task", "bt.task.wait");
    wait.properties = { durationMs: 100 };
    return tree([
      node("root", "selector", "bt.composite.selector", ["no", "seq"]),
      node("no", "task", "bt.task.fail"),
      node("seq", "sequence", "bt.composite.sequence", ["wait"]),
      wait,
    ], "root");
  };

  it("reports the nodes an evaluation entered and the links it went down, failed branches included", () => {
    const { visited, links, trace } = traced();
    evaluateBehaviourTree(waiting(), null, 0.05, { trace });
    expect([...new Set(visited)]).toEqual(["root", "no", "seq", "wait"]);
    expect(links).toEqual(["root>no", "root>seq", "seq>wait"]);
  });

  it("ticks only the running leaf while the tree waits, and goes back up when it finishes", () => {
    const doc = waiting();
    const first = evaluateBehaviourTree(doc, null, 0.05);
    const waitingTick = traced();
    const second = evaluateBehaviourTree(doc, first, 0.01, { trace: waitingTick.trace });
    expect(second.status).toBe("running");
    expect(waitingTick.visited).toEqual(["wait"]);
    expect(waitingTick.links).toEqual([]);

    const finishing = traced();
    expect(evaluateBehaviourTree(doc, second, 0.1, { trace: finishing.trace }).status).toBe("success");
    // The wait ends, then the Sequence and the Selector finish in turn.
    expect([...new Set(finishing.visited)]).toEqual(["wait", "seq", "root"]);
  });

  it("resumes every running Parallel branch each tick and reports the link into each", () => {
    const wait = node("wait", "task", "bt.task.wait");
    wait.properties = { durationMs: 1_000 };
    const doc = tree([
      node("root", "parallel", "bt.composite.parallel", ["seq", "other"]),
      node("seq", "sequence", "bt.composite.sequence", ["wait"]),
      wait,
      node("other", "task", "bt.task.wait"),
    ], "root");
    doc.nodes.find((entry) => entry.id === "other")!.properties = { durationMs: 1_000 };
    const first = evaluateBehaviourTree(doc, null, 0.05);
    const { visited, links, trace } = traced();
    evaluateBehaviourTree(doc, first, 0.05, { trace });
    expect(new Set(visited)).toEqual(new Set(["root", "seq", "wait", "other"]));
    expect(links).toContain("root>seq");
    expect(links).toContain("root>other");
  });

  it("evaluates the same with and without a trace", () => {
    const doc = waiting();
    const plain = evaluateBehaviourTree(doc, evaluateBehaviourTree(doc, null, 0.05), 0.06);
    const { trace } = traced();
    const observed = evaluateBehaviourTree(doc, evaluateBehaviourTree(doc, null, 0.05, { trace }), 0.06, { trace });
    expect(observed).toEqual(plain);
  });
});

describe("per-tick decorator scans", () => {
  const decorator = (
    id: string,
    classId: string,
    abortMode: BtDecorator["abortMode"],
    properties: Record<string, unknown> = {},
  ): BtDecorator => ({ id, classId, abortMode, observedKeys: [], properties });

  it("evaluates host decorators that observe aborts once per tick, in tree order, and no others", () => {
    const pad = node("pad", "task", "bt.task.succeed");
    pad.decorators.push(decorator("padGate", "BTDecorator_Custom", "none"));
    const guard = node("guard", "sequence", "bt.composite.sequence", ["guarded"]);
    guard.decorators.push(decorator("g1", "BTDecorator_Custom", "self"));
    const idle = node("idle", "task", "bt.task.wait");
    idle.properties = { durationMs: 10_000 };
    idle.decorators.push(
      decorator("g2", "BTDecorator_Custom", "self"),
      decorator("quiet", "BTDecorator_Custom", "none"),
      decorator("g3", "BTDecorator_Custom", "lowerPriority"),
    );
    const doc = tree(
      [
        node("root", "sequence", "bt.composite.sequence", ["pad", "guard", "idle"]),
        pad,
        guard,
        node("guarded", "task", "bt.task.succeed"),
        idle,
      ],
      "root",
    );
    const calls: string[] = [];
    const verdicts: Record<string, boolean> = {};
    // Host code may write the blackboard while it evaluates, so each call counts.
    const decoratorHost = {
      evaluate: (entry: BtDecorator, _node: BtNode, board: Record<string, unknown>) => {
        calls.push(entry.id);
        board.evaluations = ((board.evaluations as number | undefined) ?? 0) + 1;
        return verdicts[entry.id] ?? true;
      },
    };
    const tick = (previous: BtEvalState | null) => {
      calls.length = 0;
      return evaluateBehaviourTree(doc, previous, 0.016, { decoratorHost });
    };

    // Entering nodes evaluates every decorator on them; the abort pass needs a running node first.
    let state = tick(null);
    expect(calls).toEqual(["padGate", "g1", "g2", "quiet", "g3"]);
    state = tick(state);
    expect(calls).toEqual(["g1", "g2", "g3"]);
    state = tick(state);
    expect(calls).toEqual(["g1", "g2", "g3"]);
    expect(state.status).toBe("running");

    // The first decorator that aborts ends the pass: the ones after it are not evaluated.
    verdicts.g2 = false;
    state = tick(state);
    expect(calls).toEqual(["g1", "g2"]);
    expect(state.status).toBe("failure");
    expect(state.blackboard.evaluations).toBe(13);
  });

  it("counts every cooldown down on each tick, including a finished node the walk no longer visits", () => {
    const pad = node("pad", "task", "bt.task.succeed");
    pad.decorators.push(decorator("cd", "bt.decorator.cooldown", "none", { durationMs: 100 }));
    const idle = node("idle", "task", "bt.task.wait");
    idle.properties = { durationMs: 10_000 };
    const doc = tree(
      [node("root", "sequence", "bt.composite.sequence", ["pad", "idle"]), pad, idle],
      "root",
    );
    let state = evaluateBehaviourTree(doc, null, 0.05);
    const remaining = [state.nodeMemory.pad!["__cd:cd"]];
    for (let index = 0; index < 3; index += 1) {
      state = evaluateBehaviourTree(doc, state, 0.05);
      remaining.push(state.nodeMemory.pad!["__cd:cd"]);
    }
    expect(remaining).toEqual([100, 50, 0, 0]);
    expect(state.status).toBe("running");
  });

  it("reads no more decorators per tick in a large tree than in a small one", () => {
    // Per-tick work follows the nodes that carry a Cooldown or an abort mode,
    // not the size of the tree: the filler nodes below are never visited.
    const decoratorReadsPerTick = (fillers: number): number => {
      const idle = node("idle", "task", "bt.task.wait");
      idle.properties = { durationMs: 10_000 };
      idle.decorators.push(
        decorator("alive", "bt.decorator.blackboardIsSet", "self", { key: "ok" }),
      );
      const tail = node(
        "tail",
        "sequence",
        "bt.composite.sequence",
        Array.from({ length: fillers }, (_, index) => `filler-${index}`),
      );
      tail.decorators.push(decorator("cd", "bt.decorator.cooldown", "none", { durationMs: 100 }));
      const nodes = [
        node("root", "sequence", "bt.composite.sequence", ["idle", "tail"]),
        idle,
        tail,
        ...Array.from({ length: fillers }, (_, index) =>
          node(`filler-${index}`, "task", "bt.task.succeed"),
        ),
      ];
      let reads = 0;
      for (const entry of nodes) {
        const decorators = entry.decorators;
        Object.defineProperty(entry, "decorators", {
          enumerable: true,
          get: () => {
            reads += 1;
            return decorators;
          },
        });
      }
      const doc = tree(nodes, "root");
      let state = evaluateBehaviourTree(doc, null, 0.016, { blackboard: { ok: true } });
      state = evaluateBehaviourTree(doc, state, 0.016, { blackboard: { ok: true } });
      reads = 0;
      state = evaluateBehaviourTree(doc, state, 0.016, { blackboard: { ok: true } });
      expect(state.status).toBe("running");
      return reads;
    };
    expect(decoratorReadsPerTick(400)).toBe(decoratorReadsPerTick(8));
  });
});

describe("evaluation breakpoints", () => {
  function breakpointsOn(...ids: string[]) {
    const hits: string[] = [];
    return {
      hits,
      breakpoints: {
        has: (id: string) => ids.includes(id),
        hit: (id: string, event: "started" | "failed") => hits.push(`${id} ${event}`),
      },
    };
  }

  it("reports a node with a breakpoint when it starts and when it fails, but not when it resumes", () => {
    const wait = node("wait", "task", "bt.task.wait");
    wait.properties = { durationMs: 100 };
    const doc = tree([
      node("root", "selector", "bt.composite.selector", ["no", "seq"]),
      node("no", "task", "bt.task.fail"),
      node("seq", "sequence", "bt.composite.sequence", ["wait"]),
      wait,
    ], "root");
    const first = breakpointsOn("no", "seq", "wait");
    const running = evaluateBehaviourTree(doc, null, 0.05, { breakpoints: first.breakpoints });
    expect(first.hits).toEqual(["no started", "no failed", "seq started", "wait started"]);

    const second = breakpointsOn("no", "seq", "wait");
    evaluateBehaviourTree(doc, running, 0.01, { breakpoints: second.breakpoints });
    expect(second.hits).toEqual([]);
  });

  it("reports failures from a decorator, a Time Limit and an abort", () => {
    const blocked = node("blocked", "task", "bt.task.succeed");
    blocked.decorators.push({
      id: "need", classId: "bt.decorator.blackboardIsSet", abortMode: "none", observedKeys: ["flag"], properties: { key: "flag" },
    });
    const decorated = breakpointsOn("blocked");
    evaluateBehaviourTree(tree([node("root", "sequence", "bt.composite.sequence", ["blocked"]), blocked], "root"), null, 1 / 60, {
      blackboard: {}, breakpoints: decorated.breakpoints,
    });
    expect(decorated.hits).toEqual(["blocked failed"]);

    const limited = node("wait", "task", "bt.task.wait");
    limited.properties = { durationMs: 10_000 };
    limited.decorators.push({
      id: "limit", classId: "bt.decorator.timeLimit", abortMode: "none", observedKeys: [], properties: { durationMs: 80 },
    });
    const limitDoc = tree([node("root", "sequence", "bt.composite.sequence", ["wait"]), limited], "root");
    const timed = breakpointsOn("wait");
    const started = evaluateBehaviourTree(limitDoc, null, 0.05, { breakpoints: timed.breakpoints });
    expect(timed.hits).toEqual(["wait started"]);
    evaluateBehaviourTree(limitDoc, started, 0.05, { breakpoints: timed.breakpoints });
    expect(timed.hits).toEqual(["wait started", "wait failed"]);

    const guarded = node("wait", "task", "bt.task.wait");
    guarded.properties = { durationMs: 10_000 };
    guarded.decorators.push({
      id: "alive", classId: "bt.decorator.blackboardIsSet", abortMode: "self", observedKeys: ["ok"], properties: { key: "ok" },
    });
    const guardDoc = tree([node("root", "sequence", "bt.composite.sequence", ["wait"]), guarded], "root");
    const running = evaluateBehaviourTree(guardDoc, null, 0.05, { blackboard: { ok: true } });
    const aborted = breakpointsOn("wait");
    evaluateBehaviourTree(guardDoc, running, 0.05, { blackboard: {}, breakpoints: aborted.breakpoints });
    expect(aborted.hits).toEqual(["wait failed"]);
  });

  it("reports each run of a node that fails every time, and keeps the reporting out of the state", () => {
    const leaf = node("leaf", "task", "bt.task.fail");
    leaf.decorators.push({
      id: "loop", classId: "bt.decorator.loop", abortMode: "none", observedKeys: [], properties: { numLoops: 2 },
    });
    const doc = tree([node("root", "sequence", "bt.composite.sequence", ["leaf"]), leaf], "root");
    const { hits, breakpoints } = breakpointsOn("leaf");
    const first = evaluateBehaviourTree(doc, null, 1 / 60, { breakpoints });
    const second = evaluateBehaviourTree(doc, first, 1 / 60, { breakpoints });
    // Two Loop runs a pass.
    expect(hits).toEqual(Array.from({ length: 8 }, (_, index) => index % 2 === 0 ? "leaf started" : "leaf failed"));
    expect(second.lastResults).toEqual({ root: "failure", leaf: "failure" });
    expect(types.isProxy(second.lastResults)).toBe(false);
  });
});
