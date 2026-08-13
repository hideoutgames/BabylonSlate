import { describe, expect, it } from "vitest";
import {
  applyAnchorPreset,
  applyAuthoringFields,
  applyWidgetResize,
  authoringFieldsFromLayout,
  defaultAddLayout,
  laidOutParentRect,
  layoutFromRect,
  matchAnchorPreset,
  parentOwnsChildLayout,
  preferredWidgetSize,
  widgetAllowsDesignerTransform,
  ANCHOR_PRESETS,
} from "./layout-authoring";
import { computeAnchoredRect, layoutUserInterface } from "./layout";
import {
  createDefaultPlayHud,
  createWidget,
  pinLayout,
  stretchLayout,
  type Rect,
} from "./types";

const parent: Rect = { x: 0, y: 0, width: 800, height: 600 };

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function roundRect(rect: Rect): Rect {
  return {
    x: round(rect.x),
    y: round(rect.y),
    width: round(rect.width),
    height: round(rect.height),
  };
}

describe("layoutFromRect", () => {
  it("recovers pinLayout offsets for a centered 200x100 widget", () => {
    const layout = pinLayout({ x: 0.5, y: 0.5 }, { x: 200, y: 100 });
    const rect = computeAnchoredRect(parent, layout);
    const rebuilt = layoutFromRect(parent, rect, layout.anchorMin, layout.anchorMax, layout.pivot);
    expect(rebuilt.offsetMin).toEqual(layout.offsetMin);
    expect(rebuilt.offsetMax).toEqual(layout.offsetMax);
    expect(roundRect(computeAnchoredRect(parent, rebuilt))).toEqual(roundRect(rect));
  });

  it("recovers stretch insets", () => {
    const layout = stretchLayout({ left: 16, right: 24, top: 8, bottom: 12 });
    const rect = computeAnchoredRect(parent, layout);
    const rebuilt = layoutFromRect(parent, rect, layout.anchorMin, layout.anchorMax, layout.pivot);
    expect(rebuilt.offsetMin).toEqual(layout.offsetMin);
    expect(rebuilt.offsetMax).toEqual(layout.offsetMax);
  });
});

describe("anchor presets", () => {
  it("lists the 16 Unity-style presets", () => {
    expect(ANCHOR_PRESETS).toHaveLength(16);
    expect(ANCHOR_PRESETS.map((row) => row.id)).toContain("middle-center");
    expect(ANCHOR_PRESETS.map((row) => row.id)).toContain("stretch-stretch");
  });

  it("changing preset keeps the on-screen rect", () => {
    const layout = pinLayout({ x: 0.5, y: 0.5 }, { x: 120, y: 80 });
    const before = computeAnchoredRect(parent, layout);
    const next = applyAnchorPreset(layout, parent, "top-left");
    expect(next.anchorMin).toEqual({ x: 0, y: 1 });
    expect(next.anchorMax).toEqual({ x: 0, y: 1 });
    expect(roundRect(computeAnchoredRect(parent, next))).toEqual(roundRect(before));
  });

  it("stretch-stretch preset fills via offsets without jumping", () => {
    const layout = pinLayout({ x: 0.12, y: 0.18 }, { x: 160, y: 160 });
    const before = computeAnchoredRect(parent, layout);
    const next = applyAnchorPreset(layout, parent, "stretch-stretch");
    expect(next.anchorMin).toEqual({ x: 0, y: 0 });
    expect(next.anchorMax).toEqual({ x: 1, y: 1 });
    expect(roundRect(computeAnchoredRect(parent, next))).toEqual(roundRect(before));
  });

  it("matches the nearest named preset", () => {
    expect(matchAnchorPreset(pinLayout({ x: 0, y: 1 }, { x: 10, y: 10 }))).toBe(
      "top-left",
    );
    expect(matchAnchorPreset(stretchLayout())).toBe("stretch-stretch");
  });
});

describe("authoring fields", () => {
  it("exposes pos and size when pinned", () => {
    const layout = pinLayout({ x: 0.5, y: 0.5 }, { x: 200, y: 100 });
    const fields = authoringFieldsFromLayout(parent, layout);
    expect(fields.pinX).toBe(true);
    expect(fields.pinY).toBe(true);
    expect(fields.width).toBe(200);
    expect(fields.height).toBe(100);
    expect(fields.posX).toBe(0);
    expect(fields.posY).toBe(0);
  });

  it("exposes left/right/top/bottom when stretching", () => {
    const layout = stretchLayout({ left: 16, right: 24, top: 8, bottom: 12 });
    const fields = authoringFieldsFromLayout(parent, layout);
    expect(fields.pinX).toBe(false);
    expect(fields.pinY).toBe(false);
    expect(fields.left).toBe(16);
    expect(fields.right).toBe(24);
    expect(fields.top).toBe(8);
    expect(fields.bottom).toBe(12);
  });

  it("writes width around the pivot when pinned", () => {
    const layout = pinLayout({ x: 0.5, y: 0.5 }, { x: 200, y: 100 });
    const next = applyAuthoringFields(layout, parent, { width: 300 });
    const rect = computeAnchoredRect(parent, next);
    expect(rect.width).toBe(300);
    expect(rect.x + rect.width * 0.5).toBe(400);
  });

  it("writes left/right when stretching X", () => {
    const layout = stretchLayout();
    const next = applyAuthoringFields(layout, parent, { left: 40, right: 60 });
    const fields = authoringFieldsFromLayout(parent, next);
    expect(fields.left).toBe(40);
    expect(fields.right).toBe(60);
    expect(computeAnchoredRect(parent, next).width).toBe(700);
  });
});

describe("resize", () => {
  it("grows the right edge without moving the left", () => {
    const layout = pinLayout({ x: 0, y: 0 }, { x: 100, y: 40 }, { x: 0, y: 0 });
    const before = computeAnchoredRect(parent, layout);
    const next = applyWidgetResize(layout, parent, { x: 20, y: 0 }, {
      right: true,
    });
    const rect = computeAnchoredRect(parent, next);
    expect(rect.x).toBe(before.x);
    expect(rect.width).toBe(before.width + 20);
  });

  it("moves the top edge in engine Y-up", () => {
    const layout = pinLayout({ x: 0, y: 0 }, { x: 100, y: 40 }, { x: 0, y: 0 });
    const before = computeAnchoredRect(parent, layout);
    const next = applyWidgetResize(layout, parent, { x: 0, y: 10 }, {
      top: true,
    });
    const rect = computeAnchoredRect(parent, next);
    expect(rect.y).toBe(before.y);
    expect(rect.height).toBe(before.height + 10);
  });
});

describe("default add layout", () => {
  it("pins a Button at parent center with a preferred size, not stretch-fill", () => {
    const layout = defaultAddLayout("Button");
    expect(layout.anchorMin).toEqual(layout.anchorMax);
    expect(layout.anchorMin).toEqual({ x: 0.5, y: 0.5 });
    const rect = computeAnchoredRect(parent, layout);
    expect(rect.width).toBe(preferredWidgetSize("Button").width);
    expect(rect.height).toBe(preferredWidgetSize("Button").height);
    expect(rect.x + rect.width / 2).toBe(400);
  });

  it("marks box and grid parents as owning child layout", () => {
    expect(parentOwnsChildLayout("HorizontalBox")).toBe(true);
    expect(parentOwnsChildLayout("VerticalBox")).toBe(true);
    expect(parentOwnsChildLayout("Grid")).toBe(true);
    expect(parentOwnsChildLayout("SizeBox")).toBe(true);
    expect(parentOwnsChildLayout("Canvas")).toBe(false);
    expect(parentOwnsChildLayout("Overlay")).toBe(false);
  });

  it("refuses designer move/resize on the canvas root and fill-slot children", () => {
    const hud = createDefaultPlayHud("HUD");
    expect(widgetAllowsDesignerTransform(hud, hud.rootId)).toBe(false);
    expect(widgetAllowsDesignerTransform(hud, "stick")).toBe(true);
    const box = createWidget("box", "HorizontalBox", "Row");
    const child = createWidget("cell", "Button", "Cell");
    hud.widgets.canvas!.children = [...hud.widgets.canvas!.children, "box"];
    hud.widgets.box = box;
    box.children = ["cell"];
    hud.widgets.cell = child;
    expect(widgetAllowsDesignerTransform(hud, "cell")).toBe(false);
  });
});

describe("laidOutParentRect", () => {
  it("returns the canvas for the root and the parent rect for children", () => {
    const hud = createDefaultPlayHud("HUD");
    const result = layoutUserInterface(hud, { width: 1920, height: 1080 });
    expect(laidOutParentRect(result, hud.rootId)).toEqual(result.canvas);
    const stickParent = laidOutParentRect(result, "stick");
    expect(stickParent.width).toBe(result.tree?.rect.width);
  });
});
