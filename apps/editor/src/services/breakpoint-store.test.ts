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
    expect(store.enabledLocations()).toEqual([at("a")]);
    store.setAllEnabled(true);
    expect(store.enabledLocations()).toEqual([at("a"), at("b")]);
    store.toggle(at("a"), label);
    expect(store.enabledLocations()).toEqual([at("b")]);
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

  it("follows a renamed Class and a renamed function", () => {
    const store = new BreakpointStore();
    store.toggle(at("a"), label);
    store.toggle(at("b", "Shoot"), { ...label, graphName: "Shoot" });
    store.renameAsset("Content/Hero.class", "Content/Player.class");
    store.renameGraph("Content/Player.class", "Shoot", "Fire", "Fire");
    expect(store.enabledLocations()).toEqual([at("a", "event-graph", "Content/Player.class"), at("b", "Fire", "Content/Player.class")]);
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
