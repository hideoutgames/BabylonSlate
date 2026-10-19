import { describe, expect, it, vi } from "vitest";
import { GraphDebugStore } from "../services/graph-debug-store";
import { createBehaviourTreeRunTrace, createGraphRunTrace } from "./graph-run-trace";

const DOOR = { kind: "class", classId: "Door" } as const;

function followedStore() {
  const store = new GraphDebugStore();
  store.setTarget(DOOR);
  store.receiveRoster({ target: DOOR, reset: true, added: [{ id: "d1", kind: "actor", label: "Front" }], removed: [] });
  return store;
}

describe("createGraphRunTrace", () => {
  it("passes on only the runs of its own graph, and reads only its own values", () => {
    const store = followedStore();
    const trace = createGraphRunTrace(store, "Door.class", "Open");
    const listener = vi.fn();
    trace.subscribe(listener);
    store.receiveTrace({
      target: DOOR, instanceId: "d1", tickIndex: 1,
      graphs: [
        { assetGuid: "Door.class", graphId: "event-graph", nodes: ["tick"], edges: [], values: [["tick", "dt", "out", "1"]] },
        { assetGuid: "Door.class", graphId: "Open", nodes: ["a", "b"], edges: ["e"], values: [["a", "x", "in", "2"]] },
        { assetGuid: "Base.class", graphId: "Open", nodes: ["z"], edges: [], values: [["a", "x", "in", "other"]] },
      ],
    });
    expect(listener.mock.calls).toEqual([[{ nodes: ["a", "b"], edges: ["e"] }]]);
    expect(trace.value("a", "x", "in")).toBe("2");
    expect(trace.value("tick", "dt", "out")).toBeUndefined();
  });

  it("stops passing runs on once unsubscribed", () => {
    const store = followedStore();
    const trace = createGraphRunTrace(store, "Door.class", "event-graph");
    const listener = vi.fn();
    const unsubscribe = trace.subscribe(listener);
    unsubscribe();
    store.receiveTrace({
      target: DOOR, instanceId: "d1", tickIndex: 1,
      graphs: [{ assetGuid: "Door.class", graphId: "event-graph", nodes: ["a"], edges: [], values: [] }],
    });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("createBehaviourTreeRunTrace", () => {
  const GUARD = { kind: "behaviourTree", assetGuid: "guard-tree" } as const;
  function followedTree() {
    const store = new GraphDebugStore();
    store.setTarget(GUARD);
    store.receiveRoster({ target: GUARD, reset: true, added: [{ id: "bt-1", kind: "component", label: "Guard" }], removed: [] });
    return store;
  }

  it("passes on the tree's runs and links, and reports each node's status of the followed instance", () => {
    const store = followedTree();
    const trace = createBehaviourTreeRunTrace(store, "guard-tree");
    const runs = vi.fn();
    trace.subscribe(runs);
    const woken = vi.fn();
    trace.subscribeStatus!("wait", woken);

    store.receiveTrace({
      target: GUARD, instanceId: "bt-1", tickIndex: 1,
      graphs: [{ assetGuid: "guard-tree", graphId: "behaviour-tree", nodes: ["root", "wait"], edges: ["bt-root-wait"], values: [] }],
    });
    expect(runs.mock.calls).toEqual([[{ nodes: ["root", "wait"], edges: ["bt-root-wait"] }]]);

    store.receiveBtState({ instanceId: "bt-1", btNodeId: "wait", lastResults: {}, stack: [{ nodeId: "wait" }], blackboard: {} });
    expect(trace.status!("wait")).toBe("running");
    expect(woken).toHaveBeenCalledTimes(1);
  });
});
