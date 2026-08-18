import { describe, expect, it } from "vitest";
import { normalizeUserInterfaceDocument } from "./normalize-document";
import { createWidget, defaultWidgetStyle } from "./types";

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
});
