import { describe, expect, it, vi } from "vitest";
import { parseWatchFile, serializeWatchFile, WatchStore, type WatchEntry } from "./watch-store";

const pin = (nodeId: string, pinId = "value", graphId = "event-graph", assetGuid = "Content/Hero.class"): WatchEntry => ({
  kind: "pin", assetGuid, graphId, nodeId, pinId, direction: "in",
  label: { className: "Hero", graphName: "Event Graph", nodeTitle: "Set Health", pinName: "Health" },
});
const variable = (name: string, assetGuid = "Content/Hero.class"): WatchEntry =>
  ({ kind: "variable", assetGuid, name, label: { className: "Hero" } });

describe("WatchStore", () => {
  it("adds each pin or variable once, in order, and saves after each change made in the editor", () => {
    const store = new WatchStore();
    const save = vi.fn();
    store.onChange(save);
    store.add(pin("a"));
    store.add(variable("gold"));
    store.add(pin("a"));
    expect(store.list()).toEqual([pin("a"), variable("gold")]);
    expect(store.has(variable("gold"))).toBe(true);
    expect(store.has(pin("a", "value", "event-graph", "Content/Other.class"))).toBe(false);
    store.remove(pin("a"));
    expect(store.list()).toEqual([variable("gold")]);
    store.removeAll();
    expect(save).toHaveBeenCalledTimes(4);
    expect(save).toHaveBeenLastCalledWith([]);

    store.hydrate([pin("b")]);
    expect(store.list()).toEqual([pin("b")]);
    expect(save).toHaveBeenCalledTimes(4);
  });

  it("follows a renamed Class and a renamed function", () => {
    const store = new WatchStore();
    store.add(pin("a"));
    store.add(pin("b", "value", "Shoot"));
    store.add(variable("gold"));
    store.renameAsset("Content/Hero.class", "Content/Player.class");
    store.renameGraph("Content/Player.class", "Shoot", "Fire", "Fire");
    expect(store.list().map((entry) => [entry.kind, entry.assetGuid, entry.kind === "pin" ? entry.graphId : entry.name]))
      .toEqual([["pin", "Content/Player.class", "event-graph"], ["pin", "Content/Player.class", "Fire"], ["variable", "Content/Player.class", "gold"]]);
    const fire = store.list()[1];
    expect(fire?.kind === "pin" && fire.label.graphName).toBe("Fire");
  });

  it("reads back what it saved and drops anything it cannot read", () => {
    const entries = [pin("a"), variable("gold")];
    expect(parseWatchFile(serializeWatchFile(entries))).toEqual(entries);
    expect(parseWatchFile("not json")).toEqual([]);
    expect(parseWatchFile(JSON.stringify({ version: 2, watches: entries }))).toEqual([]);
    expect(parseWatchFile(JSON.stringify({ version: 1, watches: [{ kind: "pin", nodeId: "a" }, { ...variable("x"), name: 3 }, entries[1]] })))
      .toEqual([entries[1]]);
  });
});
