import { describe, expect, it } from "vitest";
import type { SerializedPin } from "@haptic/graph-ui";
import { WatchStore, type PinWatch } from "../services/watch-store";
import { watchablePins, watchPinMenuItems } from "./watch-menu";

const pin = (id: string, direction: "in" | "out", kind = "data"): SerializedPin =>
  ({ id, name: id, kind: kind as SerializedPin["kind"], direction, type: { kind: kind === "exec" ? "exec" : "float" } });
const pins = [pin("execIn", "in", "exec"), pin("newHealth", "in"), pin("bonus", "in"), pin("result", "out")];

describe("watchablePins", () => {
  it("offers outputs and the wired inputs of a node that runs, and only outputs of a pure node", () => {
    const wired = (pinId: string) => pinId === "newHealth";
    expect(watchablePins({ __pins: pins }, wired)).toEqual([
      { id: "newHealth", direction: "in", name: "New Health" },
      { id: "result", direction: "out", name: "Result" },
    ]);
    expect(watchablePins({ __pins: pins, __pure: true }, wired)).toEqual([{ id: "result", direction: "out", name: "Result" }]);
    expect(watchablePins(undefined, wired)).toEqual([]);
  });
});

describe("watchPinMenuItems", () => {
  it("toggles a watch on each pin, inputs before outputs", () => {
    const store = new WatchStore();
    const watch = (entry: { id: string; direction: "in" | "out"; name: string }): PinWatch => ({
      kind: "pin", assetGuid: "Content/Hero.class", graphId: "event-graph", nodeId: "n", pinId: entry.id, direction: entry.direction,
      label: { className: "Hero", graphName: "Event Graph", nodeTitle: "Set", pinName: entry.name },
    });
    const offered = watchablePins({ __pins: pins }, (pinId) => pinId === "newHealth");
    const [menu] = watchPinMenuItems(store, offered, watch);
    expect(menu).toMatchObject({ type: "submenu", label: "Watch Pin" });
    const items = menu?.type === "submenu" ? menu.items : [];
    expect(items.map((item) => item.type === "separator" ? "|" : item.type === "checkbox" && `${item.label}:${item.checked}`))
      .toEqual(["New Health:false", "|", "Result:false"]);
    const first = items[0];
    if (first?.type === "checkbox") first.onCheckedChange(true);
    expect(store.list()).toEqual([watch(offered[0]!)]);
    expect(watchPinMenuItems(store, [], watch)).toEqual([]);
  });
});
