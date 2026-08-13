import { describe, expect, it } from "vitest";
import {
  createDefaultUserInterface,
  createWidget,
  findUiReferenceCycle,
  nestedUiGuidsOf,
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
});
