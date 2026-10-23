import { describe, expect, it, vi } from "vitest";
import { BreakpointStore, parseBreakpointFile, serializeBreakpointFile } from "./breakpoint-store";

const label = { className: "Hero", graphName: "Event Graph", nodeTitle: "Print String" };
const at = (nodeId: string, graphId = "event-graph", assetGuid = "Content/Hero.class") => ({ assetGuid, graphId, nodeId });

describe("BreakpointStore", () => {
  it("sends a session only the enabled breakpoints", () => {
    const store = new BreakpointStore();
    store.toggle(at("a"), label);
    store.toggle(at("b"), label);
    store.setEnabled(at("b"), false);
    expect(store.enabledBreakpoints()).toEqual([at("a")]);
    store.setAllEnabled(true);
    expect(store.enabledBreakpoints()).toEqual([at("a"), at("b")]);
    store.toggle(at("a"), label);
    expect(store.enabledBreakpoints()).toEqual([at("b")]);
  });

  it("saves after each change made in the editor, never after loading", () => {
    const store = new BreakpointStore();
    const save = vi.fn();
    store.onChange(save);
    store.hydrate(parseBreakpointFile(serializeBreakpointFile([{ ...at("a"), enabled: false, label }])));
    expect(save).not.toHaveBeenCalled();
    expect(store.get(at("a"))?.enabled).toBe(false);
    store.setEnabled(at("a"), false);
    expect(save).not.toHaveBeenCalled();
    store.removeAll();
    expect(save).toHaveBeenCalledWith([]);
  });

  it("reads back what it saved and drops anything it cannot read", () => {
    const entries = [{ ...at("a"), enabled: true, label }, { ...at("b", "Shoot"), enabled: false, label }];
    expect(parseBreakpointFile(serializeBreakpointFile(entries))).toEqual(entries);
    expect(parseBreakpointFile("not json")).toEqual([]);
    expect(parseBreakpointFile(JSON.stringify({ version: 2, breakpoints: entries }))).toEqual([]);
    expect(parseBreakpointFile(JSON.stringify({ version: 1, breakpoints: [{ nodeId: "a" }, entries[0]] }))).toEqual([entries[0]]);
  });

  it("sends a session each breakpoint's condition and hit count, and saves them", () => {
    const store = new BreakpointStore();
    const save = vi.fn();
    store.onChange(save);
    store.toggle(at("a"), label);
    const condition = { pinId: "lastIndex", direction: "in" as const, op: ">=" as const, value: 2 };
    store.setSettings(at("a"), { condition, hitCount: 3 }, "Last Index");
    expect(store.enabledBreakpoints()).toEqual([{ ...at("a"), condition, hitCount: 3 }]);
    expect(store.get(at("a"))?.label.pinName).toBe("Last Index");
    expect(parseBreakpointFile(serializeBreakpointFile(save.mock.lastCall![0]))).toEqual(store.list());

    store.setSettings(at("a"), {});
    expect(store.enabledBreakpoints()).toEqual([at("a")]);
    expect(store.get(at("a"))?.label.pinName).toBeUndefined();
  });

  it("drops a saved breakpoint whose settings it cannot read", () => {
    const entry = { ...at("a"), enabled: true, label };
    const read = (extra: object) => parseBreakpointFile(JSON.stringify({ version: 1, breakpoints: [{ ...entry, ...extra }] }));
    expect(read({ hitCount: 2, condition: { pinId: "p", direction: "out", op: "isValid" } })).toHaveLength(1);
    expect(read({ hitCount: 0 })).toEqual([]);
    expect(read({ hitCount: 1.5 })).toEqual([]);
    expect(read({ condition: { pinId: "p", direction: "in", op: "~=", value: 1 } })).toEqual([]);
    expect(read({ condition: { pinId: "p", direction: "in", op: "==", value: {} } })).toEqual([]);
  });

  it("follows a renamed Class and a renamed function", () => {
    const store = new BreakpointStore();
    store.toggle(at("a"), label);
    store.toggle(at("b", "Shoot"), { ...label, graphName: "Shoot" });
    store.renameAsset("Content/Hero.class", "Content/Player.class");
    store.renameGraph("Content/Player.class", "Shoot", "Fire", "Fire");
    expect(store.enabledBreakpoints()).toEqual([at("a", "event-graph", "Content/Player.class"), at("b", "Fire", "Content/Player.class")]);
    expect(store.get(at("b", "Fire", "Content/Player.class"))?.label.graphName).toBe("Fire");
  });

  it("gives a canvas each node's state and toggles it there", () => {
    const store = new BreakpointStore();
    const view = store.graphView("Content/Hero.class", "event-graph", (nodeId) => ({ ...label, nodeTitle: nodeId }));
    const changed = vi.fn();
    const unsubscribe = view.subscribe(changed);
    view.toggle("a");
    expect(view.state("a")).toBe("enabled");
    expect(store.get(at("a"))?.label.nodeTitle).toBe("a");
    store.setEnabled(at("a"), false);
    expect(view.state("a")).toBe("disabled");
    expect(view.state("b")).toBeNull();
    expect(changed).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
