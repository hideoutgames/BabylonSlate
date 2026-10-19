import { describe, expect, it, vi } from "vitest";
import { GraphDebugStore } from "../services/graph-debug-store";
import { createGraphRunTrace } from "./graph-run-trace";

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
