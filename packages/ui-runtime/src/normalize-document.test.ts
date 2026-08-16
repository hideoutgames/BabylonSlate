import { describe, expect, it } from "vitest";
import { normalizeUserInterfaceDocument } from "./normalize-document";

describe("normalizeUserInterfaceDocument", () => {
  it("creates a Canvas root when widgets and rootId are missing", () => {
    const doc = normalizeUserInterfaceDocument({});
    expect(doc.rootId).toBe("canvas");
    expect(doc.widgets.canvas?.kind).toBe("Canvas");
    expect(doc.widgets.canvas?.children).toEqual([]);
    expect(doc.widgets.canvas?.layout).toBeDefined();
    expect(doc.widgets.canvas?.style).toBeDefined();
    expect(doc.widgets.canvas?.props).toEqual({});
  });

  it("repairs a named root that is missing from the widget map", () => {
    const doc = normalizeUserInterfaceDocument({
      rootId: "hud",
      widgets: {},
    });
    expect(doc.rootId).toBe("hud");
    expect(doc.widgets.hud?.kind).toBe("Canvas");
  });

  it("fills missing layout, style, props, and children on existing widgets", () => {
    const doc = normalizeUserInterfaceDocument({
      rootId: "canvas",
      widgets: {
        canvas: { id: "canvas", kind: "Canvas", name: "Canvas", children: ["btn"] },
        btn: { id: "btn", kind: "Button" },
      },
    });
    expect(doc.widgets.canvas?.children).toEqual(["btn"]);
    expect(doc.widgets.btn?.kind).toBe("Button");
    expect(doc.widgets.btn?.children).toEqual([]);
    expect(doc.widgets.btn?.layout.width).toBeGreaterThan(0);
    expect(doc.widgets.btn?.style).toEqual(expect.any(Object));
    expect(doc.widgets.btn?.props.text).toBe("Button");
    expect(doc.widgets.btn?.visible).toBe(true);
  });

  it("drops invalid child ids and unknown widget kinds become Border", () => {
    const doc = normalizeUserInterfaceDocument({
      rootId: "canvas",
      widgets: {
        canvas: {
          id: "canvas",
          kind: "Canvas",
          children: ["btn", "missing", 12],
        },
        btn: { id: "btn", kind: "NotAWidget" },
      },
    });
    expect(doc.widgets.canvas?.children).toEqual(["btn"]);
    expect(doc.widgets.btn?.kind).toBe("Border");
  });
});
