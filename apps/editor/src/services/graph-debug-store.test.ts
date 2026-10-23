import { describe, expect, it, vi } from "vitest";
import type { DebugGraphTrace, DebugInstance, DebugObserveTarget } from "@haptic/bridge";
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

describe("GraphDebugStore at a breakpoint", () => {
  it("follows the object that stopped, now when it is listed or once a roster lists it", () => {
    const { store, requests } = observed();
    store.receiveRoster(roster([actor("a"), actor("b")], [], true));
    store.follow("b");
    expect(requests.at(-1)).toEqual({ target: DOOR, instanceId: "b" });

    // The stop opened another Class: its roster arrives after the follow, and the object is in it.
    store.follow("w2");
    store.setTarget(WINDOW);
    store.receiveRoster(roster([actor("w1"), actor("w2")], [], true, WINDOW));
    expect(store.getSnapshot().selectedId).toBe("w2");
  });

  it("drops a follow the user overrides, and never follows an object no roster lists", () => {
    const { store } = observed();
    store.receiveRoster(roster([actor("a"), actor("b")], [], true));
    store.follow("subclass-instance");
    expect(store.getSnapshot().selectedId).toBe("a");
    store.select("b");
    store.receiveRoster(roster([actor("subclass-instance")]));
    expect(store.getSnapshot().selectedId).toBe("b");
  });

  it("holds the canvases while paused, and lets the old path go when another object is followed", () => {
    const { store } = observed();
    store.receiveRoster(roster([actor("a"), actor("b")], [], true));
    const held: boolean[] = [];
    store.subscribeHold((value) => held.push(value));
    store.setHeld(true);
    store.select("b");
    store.setHeld(false);
    expect(held).toEqual([false, true, false, true, false]);
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

describe("GraphDebugStore variables", () => {
  it("keeps the followed instance's variable texts and tells value listeners about them and traces", () => {
    const { store } = observed();
    store.receiveRoster(roster([actor("a"), actor("b")], [], true));
    const changed = vi.fn();
    store.subscribeValues(changed);
    store.receiveVariables({ target: DOOR, instanceId: "a", tickIndex: 1, values: [["gold", "3"], ["owner", "Mira"]] });
    store.receiveVariables({ target: DOOR, instanceId: "a", tickIndex: 2, values: [["gold", "7"]] });
    expect(store.variable("gold")).toBe("7");
    expect(store.variable("owner")).toBe("Mira");
    store.receiveTrace({ target: DOOR, instanceId: "a", tickIndex: 3, graphs: [graphTrace([["n", "p", "in", "1"]])] });
    expect(changed).toHaveBeenCalledTimes(3);

    // Another instance's report is dropped, and following it forgets the old texts.
    store.receiveVariables({ target: DOOR, instanceId: "b", tickIndex: 3, values: [["gold", "0"]] });
    expect(store.variable("gold")).toBe("7");
    store.select("b");
    expect(store.variable("gold")).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(4);
  });
});

describe("GraphDebugStore Behaviour Tree state", () => {
  const GUARD: DebugObserveTarget = { kind: "behaviourTree", assetGuid: "guard-tree" };
  const component = (id: string): DebugInstance => ({ id, kind: "component", label: id });
  const state = (instanceId: string, patch: Partial<Parameters<GraphDebugStore["receiveBtState"]>[0]> = {}) => ({
    instanceId, btNodeId: null, lastResults: {}, stack: [], blackboard: {}, ...patch,
  });
  function following(...ids: string[]) {
    const store = new GraphDebugStore();
    store.setTarget(GUARD);
    store.receiveRoster({ target: GUARD, reset: true, added: ids.map(component), removed: [] });
    return store;
  }

  it("shows the followed tree's node statuses, running for the whole active branch", () => {
    const store = following("a");
    store.receiveBtState(state("a", {
      btNodeId: "wait", lastResults: { blocked: "failure", wait: "running" },
      stack: [{ nodeId: "root" }, { nodeId: "wait" }],
    }));
    expect(["root", "blocked", "wait", "other"].map((id) => store.status("guard-tree", id)))
      .toEqual(["running", "failure", "running", undefined]);
    // Another tree's canvas reads nothing of this one.
    expect(store.status("other-tree", "root")).toBeUndefined();
  });

  it("wakes only the nodes whose status changed", () => {
    const store = following("a");
    const woken: string[] = [];
    for (const id of ["root", "wait", "done"]) store.subscribeStatus(id, () => woken.push(id));
    store.receiveBtState(state("a", { lastResults: { done: "success" }, stack: [{ nodeId: "root" }, { nodeId: "wait" }] }));
    expect(woken.sort()).toEqual(["done", "root", "wait"]);
    woken.length = 0;
    store.receiveBtState(state("a", { lastResults: { done: "success" }, stack: [{ nodeId: "root" }, { nodeId: "wait" }], blackboard: { hp: 1 } }));
    expect(woken).toEqual([]);
    store.receiveBtState(state("a", { lastResults: { done: "success", wait: "success" }, stack: [{ nodeId: "root" }] }));
    expect(woken).toEqual(["wait"]);
  });

  it("holds the Blackboard the tree last reported and wakes its readers", () => {
    const store = following("a");
    const woken = vi.fn();
    store.subscribeBlackboard(woken);
    expect(store.blackboard("guard-tree")).toBeNull();
    store.receiveBtState(state("a", { blackboard: { hp: 3 } }));
    expect(store.blackboard("guard-tree")).toEqual({ hp: 3 });
    expect(store.blackboard("other-tree")).toBeNull();
    expect(woken).toHaveBeenCalledTimes(1);
  });

  it("drops the state of an instance that is not followed, and of a target that is not a tree", () => {
    const store = following("a", "b");
    store.receiveBtState(state("b", { stack: [{ nodeId: "root" }], blackboard: { hp: 9 } }));
    expect(store.status("guard-tree", "root")).toBeUndefined();
    expect(store.blackboard("guard-tree")).toBeNull();

    const classStore = observed().store;
    classStore.receiveRoster(roster([actor("a")], [], true));
    classStore.receiveBtState(state("a", { stack: [{ nodeId: "root" }] }));
    expect(classStore.status("guard-tree", "root")).toBeUndefined();
  });

  it("forgets the status and Blackboard of an instance when another is followed or the target goes away", () => {
    const store = following("a", "b");
    const woken: string[] = [];
    store.subscribeStatus("root", () => woken.push("root"));
    store.subscribeBlackboard(() => woken.push("blackboard"));
    store.receiveBtState(state("a", { stack: [{ nodeId: "root" }], blackboard: { hp: 3 } }));
    woken.length = 0;

    store.select("b");
    expect(woken.sort()).toEqual(["blackboard", "root"]);
    expect(store.status("guard-tree", "root")).toBeUndefined();
    expect(store.blackboard("guard-tree")).toBeNull();

    store.receiveBtState(state("b", { stack: [{ nodeId: "root" }], blackboard: { hp: 1 } }));
    woken.length = 0;
    store.setTarget(null);
    expect(woken.sort()).toEqual(["blackboard", "root"]);
  });
});
