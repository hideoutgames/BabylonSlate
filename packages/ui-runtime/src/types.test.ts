import { describe, expect, it } from "vitest";
import { normalizeUserInterfaceDocument } from "./normalize-document";
import { createWidget, defaultHitTestableFor, defaultWidgetStyle } from "./types";

describe("createWidget style defaults", () => {
  it("gives newly created Buttons an explicit visible background", () => {
    const button = createWidget("btn", "Button", "Play");
    expect(button.style.background).toBe("#333333");
  });

  it("does not invent a background on non-Button widgets", () => {
    expect(createWidget("label", "Text").style.background).toBeUndefined();
    expect(createWidget("art", "Image").style.background).toBeUndefined();
    expect(defaultWidgetStyle().background).toBeUndefined();
  });
});

describe("Hit Testable defaults", () => {
  it("enables Button and Touch widgets and disables everything else", () => {
    expect(defaultHitTestableFor("Button")).toBe(true);
    expect(defaultHitTestableFor("TouchButton")).toBe(true);
    expect(defaultHitTestableFor("TouchJoystick")).toBe(true);
    expect(defaultHitTestableFor("TouchDPad")).toBe(true);
    expect(defaultHitTestableFor("Image")).toBe(false);
    expect(defaultHitTestableFor("Text")).toBe(false);
    expect(defaultHitTestableFor("Slider")).toBe(false);
    expect(defaultHitTestableFor("CheckBox")).toBe(false);
    expect(defaultHitTestableFor("TextInput")).toBe(false);
    expect(defaultHitTestableFor("Canvas")).toBe(false);
    expect(defaultHitTestableFor("ProgressBar")).toBe(false);
    expect(defaultHitTestableFor("Spacer")).toBe(false);
    expect(defaultHitTestableFor("HorizontalBox")).toBe(false);
    expect(defaultHitTestableFor("UserInterface")).toBe(false);
  });

  it("stamps createWidget with the kind default", () => {
    expect(createWidget("btn", "Button").hitTestable).toBe(true);
    expect(createWidget("art", "Image").hitTestable).toBe(false);
  });
});

describe("normalizeUserInterfaceDocument button chrome", () => {
  it("preserves a loaded Button that intentionally omits a background", () => {
    const doc = normalizeUserInterfaceDocument({
      rootId: "canvas",
      widgets: {
        canvas: { id: "canvas", kind: "Canvas", children: ["btn"] },
        btn: { id: "btn", kind: "Button" },
      },
    });
    expect(doc.widgets.btn?.style.background).toBeUndefined();
  });

  it("keeps an authored Button background", () => {
    const doc = normalizeUserInterfaceDocument({
      rootId: "canvas",
      widgets: {
        canvas: { id: "canvas", kind: "Canvas", children: ["btn"] },
        btn: { id: "btn", kind: "Button", style: { background: "#112233" } },
      },
    });
    expect(doc.widgets.btn?.style.background).toBe("#112233");
  });

  it("fills missing Hit Testable from the kind default and keeps authored values", () => {
    const doc = normalizeUserInterfaceDocument({
      rootId: "canvas",
      widgets: {
        canvas: { id: "canvas", kind: "Canvas", children: ["btn", "art"] },
        btn: { id: "btn", kind: "Button" },
        art: { id: "art", kind: "Image", hitTestable: true },
      },
    });
    expect(doc.widgets.canvas?.hitTestable).toBe(false);
    expect(doc.widgets.btn?.hitTestable).toBe(true);
    expect(doc.widgets.art?.hitTestable).toBe(true);
  });
});
