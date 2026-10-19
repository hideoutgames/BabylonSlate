import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  GraphDebugProvider,
  useAnimObjectGraphRunTrace,
  useAnimStateMachineRunTrace,
  useBehaviourTreeRunTrace,
  useClassGraphRunTrace,
  useGraphDebugStore,
} from "./graph-debug-context";

const DOOR = { kind: "class", classId: "Door" } as const;

function mountGraph(classId: string | undefined = "Door", assetPath: string | undefined = "assets/Door.class.babasset") {
  return renderHook(
    () => ({ store: useGraphDebugStore()!, trace: useClassGraphRunTrace(assetPath, classId, "event-graph") }),
    { wrapper: GraphDebugProvider },
  );
}

describe("useClassGraphRunTrace", () => {
  it("gives a Class graph nothing to draw until a Simulation follows its class", () => {
    const view = mountGraph();
    expect(view.result.current.trace).toBeUndefined();
    act(() => view.result.current.store.setTarget(DOOR));
    expect(view.result.current.trace).toBeDefined();
    act(() => view.result.current.store.setTarget(null));
    expect(view.result.current.trace).toBeUndefined();
  });

  it("gives another Class's graph nothing while a different class is followed", () => {
    const view = mountGraph("Lamp", "assets/Lamp.class.babasset");
    act(() => view.result.current.store.setTarget(DOOR));
    expect(view.result.current.trace).toBeUndefined();
  });

  it("passes on the runs of the followed instance in its own graph", () => {
    const view = mountGraph();
    const { store } = view.result.current;
    act(() => {
      store.setTarget(DOOR);
      store.receiveRoster({ target: DOOR, reset: true, added: [{ id: "d1", kind: "actor", label: "Front" }], removed: [] });
    });
    const listener = vi.fn();
    view.result.current.trace!.subscribe(listener);
    store.receiveTrace({
      target: DOOR, instanceId: "d1", tickIndex: 1,
      graphs: [{ assetGuid: "assets/Door.class.babasset", graphId: "event-graph", nodes: ["tick"], edges: [], values: [] }],
    });
    expect(listener).toHaveBeenCalledWith({ nodes: ["tick"], edges: [] });
  });
});

describe("run traces of Behaviour Trees and Animation Graphs", () => {
  const GUARD = { kind: "behaviourTree", assetGuid: "guard-tree" } as const;
  const LOCO = { kind: "animationGraph", assetGuid: "loco-graph" } as const;
  const traces = (treeGuid: string | undefined, graphGuid: string | undefined) => renderHook(
    () => ({
      store: useGraphDebugStore()!,
      tree: useBehaviourTreeRunTrace(treeGuid),
      machine: useAnimStateMachineRunTrace(graphGuid),
      object: useAnimObjectGraphRunTrace("assets/Loco.anim.babasset", graphGuid),
    }),
    { wrapper: GraphDebugProvider },
  );

  it("gives a tree's canvas a trace, with node status, only while its own tree is debugged", () => {
    const view = traces("guard-tree", "loco-graph");
    expect(view.result.current.tree).toBeUndefined();
    act(() => view.result.current.store.setTarget(GUARD));
    expect(view.result.current.tree?.status).toBeTypeOf("function");
    expect(view.result.current.machine).toBeUndefined();
    act(() => view.result.current.store.setTarget({ kind: "behaviourTree", assetGuid: "other-tree" }));
    expect(view.result.current.tree).toBeUndefined();
  });

  it("gives an Animation Graph's two canvases a trace each, under their own graph ids", () => {
    const view = traces(undefined, "loco-graph");
    const { store } = view.result.current;
    act(() => {
      store.setTarget(LOCO);
      store.receiveRoster({ target: LOCO, reset: true, added: [{ id: "anim-1", kind: "component", label: "Hero" }], removed: [] });
    });
    expect(view.result.current.tree).toBeUndefined();
    const machine = vi.fn();
    const object = vi.fn();
    view.result.current.machine!.subscribe(machine);
    view.result.current.object!.subscribe(object);
    store.receiveTrace({
      target: LOCO, instanceId: "anim-1", tickIndex: 1,
      graphs: [
        { assetGuid: "loco-graph", graphId: "state-machine", nodes: ["run"], edges: ["idle-run"], values: [] },
        { assetGuid: "assets/Loco.anim.babasset", graphId: "animation-object", nodes: ["update"], edges: [], values: [] },
      ],
    });
    expect(machine.mock.calls).toEqual([[{ nodes: ["run"], edges: ["idle-run"] }]]);
    expect(object.mock.calls).toEqual([[{ nodes: ["update"], edges: [] }]]);
  });

  it("keeps a canvas's trace when instances spawn and despawn", () => {
    const view = traces("guard-tree", undefined);
    const { store } = view.result.current;
    act(() => store.setTarget(GUARD));
    const trace = view.result.current.tree;
    act(() => store.receiveRoster({ target: GUARD, reset: true, added: [{ id: "bt-1", kind: "component", label: "Guard" }], removed: [] }));
    act(() => store.receiveRoster({ target: GUARD, reset: false, added: [{ id: "bt-2", kind: "component", label: "Scout" }], removed: [] }));
    expect(view.result.current.tree).toBe(trace);
  });
});
