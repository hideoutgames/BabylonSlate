import { describe, expect, it } from "vitest";
import type { DebugObserveTarget } from "@haptic/bridge";
import { GraphDebugStore } from "../services/graph-debug-store";
import type { WatchEntry } from "../services/watch-store";
import { readWatch, watchReadingText } from "./watch-readings";

const HERO: DebugObserveTarget = { kind: "class", classId: "Hero" };
const pinWatch: WatchEntry = {
  kind: "pin", assetGuid: "assets/Hero.class.hasset", graphId: "event-graph", nodeId: "set", pinId: "value", direction: "in",
  label: { className: "Hero", graphName: "Event Graph", nodeTitle: "Set Health", pinName: "Value" },
};
const goldWatch: WatchEntry = { kind: "variable", assetGuid: "assets/Hero.class.hasset", name: "gold", label: { className: "Hero" } };

describe("readWatch", () => {
  it("says why a watch has no value until the followed object of its Class reports one", () => {
    const debug = new GraphDebugStore();
    expect(watchReadingText(readWatch(goldWatch, debug))).toBe("Not Debugged");
    debug.setTarget({ kind: "class", classId: "Villain" });
    expect(readWatch(goldWatch, debug)).toEqual({ kind: "notDebugged" });

    debug.setTarget(HERO);
    debug.receiveRoster({ target: HERO, reset: true, added: [], removed: [] });
    expect(watchReadingText(readWatch(goldWatch, debug))).toBe("No Object");

    debug.receiveRoster({ target: HERO, reset: false, added: [{ id: "h1", kind: "actor", label: "Hero" }], removed: [] });
    expect(watchReadingText(readWatch(pinWatch, debug))).toBe("No Value Yet");
    debug.receiveVariables({ target: HERO, instanceId: "h1", tickIndex: 1, values: [["gold", "12"]] });
    debug.receiveTrace({ target: HERO, instanceId: "h1", tickIndex: 1, graphs: [{
      assetGuid: "assets/Hero.class.hasset", graphId: "event-graph", nodes: ["set"], edges: [], values: [["set", "value", "in", "40"]],
    }] });
    expect(readWatch(goldWatch, debug)).toEqual({ kind: "value", text: "12" });
    expect(readWatch(pinWatch, debug)).toEqual({ kind: "value", text: "40" });
  });
});
