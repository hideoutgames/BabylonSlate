import { describe, expect, it } from "vitest";
import {
  createDefaultUserInterface,
  createWidget,
  findUiReferenceCycle,
  nestedUiGuidsOf,
  nestedUiPickableGuids,
  uiDocumentWouldCycle,
} from "./index";

describe("UI reference cycle check", () => {
  it("returns null for a DAG", () => {
    const cycle = findUiReferenceCycle("a", (guid) => {
      if (guid === "a") return ["b"];
      if (guid === "b") return ["c"];
      return [];
    });
    expect(cycle).toBeNull();
  });

  it("returns the looping path", () => {
    const cycle = findUiReferenceCycle("a", (guid) => {
      if (guid === "a") return ["b"];
      if (guid === "b") return ["c"];
      if (guid === "c") return ["a"];
      return [];
    });
    expect(cycle).toEqual(["a", "b", "c", "a"]);
  });

  it("detects a self-override on the document under edit", () => {
    const doc = createDefaultUserInterface();
    const button = createWidget("btn", "Button", "Play");
    button.visualOverrideGuid = "hud";
    doc.widgets.canvas!.children = ["btn"];
    doc.widgets.btn = button;
    expect(nestedUiGuidsOf(doc)).toEqual(["hud"]);
    expect(uiDocumentWouldCycle("hud", doc, () => null)).toEqual(["hud", "hud"]);
  });

  it("excludes self and cycle partners from nested UserInterface picks", () => {
    const hud = createDefaultUserInterface("HUD");
    const panel = createDefaultUserInterface("Panel");
    const chip = createDefaultUserInterface("Chip");
    const nested = createWidget("child", "UserInterface", "Child");
    nested.nestedUiGuid = "chip";
    panel.widgets.canvas!.children = ["child"];
    panel.widgets.child = nested;

    const resolve = (guid: string) => {
      if (guid === "panel") return panel;
      if (guid === "chip") return chip;
      return null;
    };

    expect(
      nestedUiPickableGuids("hud", ["hud", "panel", "chip"], hud, resolve),
    ).toEqual(["panel", "chip"]);
    expect(
      nestedUiPickableGuids("chip", ["hud", "panel", "chip"], chip, resolve),
    ).toEqual(["hud"]);
  });
});
