import { describe, expect, it, vi } from "vitest";
import type { DebugGraphTrace, DebugInstance, DebugObserveTarget } from "@babylonslate/bridge";
import { GraphDebugStore, type GraphDebugRequest } from "./graph-debug-store";

const DOOR: DebugObserveTarget = { kind: "class", classId: "Door" };
const WINDOW: DebugObserveTarget = { kind: "class", classId: "Window" };

const actor = (id: string, label = id): DebugInstance => ({ id, kind: "actor", label });

function roster(added: DebugInstance[], removed: string[] = [], reset = false, target = DOOR) {
  return { target, reset, added, removed };
}

function graphTrace(values: DebugGraphTrace["values"], nodes: string[] = ["a"]): DebugGraphTrace {
  return { assetGuid: "Door.class", graphId: "event-graph", nodes, edges: [], values };
}

function observed() {
  const store = new GraphDebugStore();
  const requests: GraphDebugRequest[] = [];
  store.subscribeRequest((request) => requests.push(request));
  store.setTarget(DOOR);
  return { store, requests };
}

describe("GraphDebugStore selection", () => {
  it("lists nothing, follows nothing and asks the runtime for the target's roster first", () => {
    const { store, requests } = observed();
    expect(store.getSnapshot()).toEqual({ target: DOOR, instances: null, selectedId: null });
    expect(requests).toEqual([{ target: DOOR, instanceId: null }]);
  });

  it("follows the first listed instance by default and None when the roster is empty", () => {
    const { store, requests } = observed();
    store.receiveRoster(roster([], [], true));
    expect(store.getSnapshot()).toEqual({ target: DOOR, instances: [], selectedId: null });
    store.receiveRoster(roster([actor("b"), actor("a")]));
    expect(store.getSnapshot().selectedId).toBe("b");
    expect(requests.at(-1)).toEqual({ target: DOOR, instanceId: "b" });
  });

  it("keeps a user's pick when others spawn and despawn", () => {
    const { store } = observed();
    store.receiveRoster(roster([actor("a"), actor("b")], [], true));
    store.select("b");
    store.receiveRoster(roster([actor("c")], ["a"]));
    expect(store.getSnapshot().selectedId).toBe("b");
    expect(store.getSnapshot().instances!.map((instance) => instance.id)).toEqual(["b", "c"]);
  });

  it("falls back to the first remaining instance when the followed one despawns, else None", () => {
    const { store, requests } = observed();
    store.receiveRoster(roster([actor("a"), actor("b"), actor("c")], [], true));
    store.select("b");
    store.receiveRoster(roster([], ["b"]));
    expect(store.getSnapshot().selectedId).toBe("a");
    expect(requests.at(-1)).toEqual({ target: DOOR, instanceId: "a" });
    store.receiveRoster(roster([], ["a", "c"]));
    expect(store.getSnapshot()).toMatchObject({ instances: [], selectedId: null });
    // The first instance to appear is followed again.
    store.receiveRoster(roster([actor("d")]));
    expect(store.getSnapshot().selectedId).toBe("d");
  });

  it("keeps None when the user chose it, until the target changes", () => {
    const { store, requests } = observed();
    store.receiveRoster(roster([actor("a")], [], true));
    store.select(null);
    expect(requests.at(-1)).toEqual({ target: DOOR, instanceId: null });
    store.receiveRoster(roster([actor("b")]));
    expect(store.getSnapshot().selectedId).toBeNull();
    store.setTarget(WINDOW);
    store.receiveRoster(roster([actor("w1")], [], true, WINDOW));
    expect(store.getSnapshot().selectedId).toBe("w1");
  });

  it("ignores a pick that is not listed and a roster for another target", () => {
    const { store } = observed();
    store.receiveRoster(roster([actor("a")], [], true));
    store.select("ghost");
    expect(store.getSnapshot().selectedId).toBe("a");
    store.receiveRoster(roster([actor("x")], [], true, WINDOW));
    expect(store.getSnapshot().instances!.map((instance) => instance.id)).toEqual(["a"]);
  });

  it("asks the runtime to stop when the target goes away", () => {
    const { store, requests } = observed();
    store.receiveRoster(roster([actor("a")], [], true));
    store.setTarget(null);
    expect(store.getSnapshot()).toEqual({ target: null, instances: null, selectedId: null });
    expect(requests.at(-1)).toEqual({ target: null, instanceId: null });
    const before = requests.length;
    store.setTarget(null);
    expect(requests).toHaveLength(before);
  });

  it("tells a late request listener the current request at once", () => {
    const { store } = observed();
    store.receiveRoster(roster([actor("a")], [], true));
    const late = vi.fn();
    store.subscribeRequest(late);
    expect(late).toHaveBeenCalledExactlyOnceWith({ target: DOOR, instanceId: "a" });
  });

  it("wakes React readers for roster and selection changes only", () => {
    const { store } = observed();
    const react = vi.fn();
    store.subscribe(react);
    store.receiveRoster(roster([actor("a")], [], true));
    expect(react).toHaveBeenCalledTimes(1);
    store.receiveTrace({ target: DOOR, instanceId: "a", tickIndex: 1, graphs: [graphTrace([["n", "p", "in", "1"]])] });
    expect(react).toHaveBeenCalledTimes(1);
  });
});

describe("GraphDebugStore traces", () => {
  it("hands the followed instance's trace to listeners and keeps each pin's latest value", () => {
    const { store } = observed();
    store.receiveRoster(roster([actor("a")], [], true));
    const seen: number[] = [];
    store.subscribeTrace((trace) => seen.push(trace.tickIndex));
    expect(store.value("Door.class", "event-graph", "n", "p", "in")).toBeUndefined();
    store.receiveTrace({ target: DOOR, instanceId: "a", tickIndex: 4, graphs: [graphTrace([["n", "p", "in", "1"], ["n", "p", "out", "2"]])] });
    store.receiveTrace({ target: DOOR, instanceId: "a", tickIndex: 5, graphs: [graphTrace([["n", "p", "in", "3"]])] });
    expect(seen).toEqual([4, 5]);
    expect(store.value("Door.class", "event-graph", "n", "p", "in")).toBe("3");
    expect(store.value("Door.class", "event-graph", "n", "p", "out")).toBe("2");
    expect(store.value("Door.class", "Open", "n", "p", "in")).toBeUndefined();
  });

  it("drops a trace of an instance that is no longer followed or of another target", () => {
    const { store } = observed();
    store.receiveRoster(roster([actor("a"), actor("b")], [], true));
    const seen = vi.fn();
    store.subscribeTrace(seen);
    store.select("b");
    store.receiveTrace({ target: DOOR, instanceId: "a", tickIndex: 1, graphs: [graphTrace([["n", "p", "in", "late"]])] });
    store.receiveTrace({ target: WINDOW, instanceId: "b", tickIndex: 1, graphs: [graphTrace([["n", "p", "in", "other"]])] });
    expect(seen).not.toHaveBeenCalled();
    expect(store.value("Door.class", "event-graph", "n", "p", "in")).toBeUndefined();
  });

  it("forgets values when another instance is followed", () => {
    const { store } = observed();
    store.receiveRoster(roster([actor("a"), actor("b")], [], true));
    store.receiveTrace({ target: DOOR, instanceId: "a", tickIndex: 1, graphs: [graphTrace([["n", "p", "in", "1"]])] });
    store.select("b");
    expect(store.value("Door.class", "event-graph", "n", "p", "in")).toBeUndefined();
  });
});
