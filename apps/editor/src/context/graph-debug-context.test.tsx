import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GraphDebugProvider, useClassGraphRunTrace, useGraphDebugStore } from "./graph-debug-context";

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
