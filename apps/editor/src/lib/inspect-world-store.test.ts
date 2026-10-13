import { describe, expect, it, vi } from "vitest";
import type { DebugInspectNode, DebugInspectSnapshot } from "@babylonslate/object-model";
import { createInspectWorldStore, sameInspectValue } from "./inspect-world-store";

function actor(id: string, label: string, variables: Record<string, unknown> = {}): DebugInspectNode {
  return { id, kind: "actor", label, classId: "Actor", parentId: null, variables };
}

function snapshot(tickIndex: number, nodes: DebugInspectNode[]): DebugInspectSnapshot {
  return { tickIndex, nodes };
}

describe("InspectWorldStore", () => {
  it("keeps the snapshot and tells nobody when a poll returns identical content", () => {
    const store = createInspectWorldStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.publish(snapshot(3, [actor("hero", "Hero", { health: 10, tags: ["a"] })]));
    const first = store.getSnapshot();

    store.publish(snapshot(3, [actor("hero", "Hero", { health: 10, tags: ["a"] })]));

    expect(store.getSnapshot()).toBe(first);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the tick", snapshot(4, [actor("hero", "Hero", { health: 10 })])],
    ["a variable", snapshot(3, [actor("hero", "Hero", { health: 9 })])],
    ["a nested value", snapshot(3, [actor("hero", "Hero", { health: 10, tags: ["b"] })])],
    ["a node", snapshot(3, [actor("hero", "Hero", { health: 10 }), actor("npc", "Npc")])],
  ])("publishes a snapshot that differs in %s", (_what, next) => {
    const store = createInspectWorldStore();
    store.publish(snapshot(3, [actor("hero", "Hero", { health: 10, tags: ["a"] })]));
    const listener = vi.fn();
    store.subscribe(listener);

    store.publish(next);

    expect(store.getSnapshot()).toBe(next);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("stops notifying a listener that unsubscribed", () => {
    const store = createInspectWorldStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    store.publish(snapshot(1, []));
    expect(listener).not.toHaveBeenCalled();
  });

  it("lists actors by id and label, unchanged while only values change", () => {
    const store = createInspectWorldStore();
    store.publish(snapshot(1, [
      { id: "gi", kind: "gameInstance", label: "Game", classId: "GameInstance", parentId: null, variables: {} },
      actor("hero", "Hero", { health: 10 }),
    ]));
    const actors = store.getActors();
    expect(actors).toEqual([{ kind: "actor", label: "Hero", id: "hero" }]);

    store.publish(snapshot(2, [actor("hero", "Hero", { health: 9 })]));
    expect(store.getActors()).toBe(actors);

    store.publish(snapshot(3, [actor("hero", "Hero Prime", { health: 9 })]));
    expect(store.getActors()).toEqual([{ kind: "actor", label: "Hero Prime", id: "hero" }]);
  });
});

describe("sameInspectValue", () => {
  it("compares plain data by structure", () => {
    expect(sameInspectValue({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toBe(true);
    expect(sameInspectValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameInspectValue([1, 2], [1, 2, 3])).toBe(false);
    expect(sameInspectValue([], {})).toBe(false);
  });

  it("never treats two different non-plain values as equal, so a change is not hidden", () => {
    expect(sameInspectValue(new Map([["a", 1]]), new Map([["a", 2]]))).toBe(false);
    expect(sameInspectValue(new Map(), new Map())).toBe(false);
    const shared = new Map();
    expect(sameInspectValue(shared, shared)).toBe(true);
  });
});
