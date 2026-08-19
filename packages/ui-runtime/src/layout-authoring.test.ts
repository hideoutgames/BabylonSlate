import { describe, expect, it } from "vitest";
import {
  applyAnchorPreset,
  applyAuthoringFields,
  applyWidgetResize,
  authoringFieldsFromLayout,
  authoringParentRect,
  convertLayoutSize,
  defaultAddLayout,
  laidOutParentRect,
  layoutFromRect,
  matchAnchorPreset,
  parentOwnsChildLayout,
  preferredWidgetSize,
  widgetAllowsDesignerTransform,
  ANCHOR_PRESETS,
} from "./layout-authoring";
import { layoutUserInterface, previewRect } from "./layout";
import {
  ZERO_INSETS,
  createDefaultPlayHud,
  createDefaultUserInterface,
  createWidget,
  pinLayout,
  stretchLayout,
  type Rect,
} from "./types";
import { roundRect } from "./preview-rect";

const parent: Rect = { x: 0, y: 0, width: 800, height: 600 };

describe("layoutFromRect", () => {
  it("recovers a centered pin", () => {
    const layout = pinLayout("center", "center", 200, 100);
    const rect = previewRect(parent, layout);
    const rebuilt = layoutFromRect(parent, rect, "middle-center", layout.transformCenter);
    expect(roundRect(previewRect(parent, rebuilt))).toEqual(roundRect(rect));
  });

  it("recovers stretch insets", () => {
    const layout = stretchLayout({ left: 16, right: 24, top: 8, bottom: 12 });
    const rect = previewRect(parent, layout);
    const rebuilt = layoutFromRect(parent, rect, "stretch-stretch");
    expect(rebuilt.widthUnit).toBe("percent");
    expect(rebuilt.heightUnit).toBe("percent");
    expect(roundRect(previewRect(parent, rebuilt))).toEqual(roundRect(rect));
  });
});

describe("anchor presets", () => {
  it("lists the 16 alignment macros", () => {
    expect(ANCHOR_PRESETS).toHaveLength(16);
    expect(ANCHOR_PRESETS.map((row) => row.id)).toContain("middle-center");
    expect(ANCHOR_PRESETS.map((row) => row.id)).toContain("stretch-stretch");
  });

  it("changing preset keeps the on-screen rect", () => {
    const layout = pinLayout("center", "center", 120, 80);
    const before = previewRect(parent, layout);
    const next = applyAnchorPreset(layout, parent, "top-left");
    expect(next.horizontalAlignment).toBe("left");
    expect(next.verticalAlignment).toBe("top");
    expect(roundRect(previewRect(parent, next))).toEqual(roundRect(before));
  });

  it("stretch-stretch preset fills via padding without jumping", () => {
    const layout = pinLayout("left", "bottom", 160, 160, 40, 0);
    const before = previewRect(parent, layout);
    const next = applyAnchorPreset(layout, parent, "stretch-stretch");
    expect(next.widthUnit).toBe("percent");
    expect(next.heightUnit).toBe("percent");
    expect(roundRect(previewRect(parent, next))).toEqual(roundRect(before));
  });

  it("matches the nearest named preset", () => {
    expect(matchAnchorPreset(pinLayout("left", "top", 10, 10))).toBe("top-left");
    expect(matchAnchorPreset(stretchLayout())).toBe("stretch-stretch");
  });
});

describe("authoring fields", () => {
  it("exposes left/top and size when pinned", () => {
    const layout = pinLayout("center", "center", 200, 100);
    const fields = authoringFieldsFromLayout(parent, layout);
    expect(fields.pinX).toBe(true);
    expect(fields.pinY).toBe(true);
    expect(fields.width).toBe(200);
    expect(fields.height).toBe(100);
    expect(fields.posX).toBe(0);
    expect(fields.posY).toBe(0);
  });

  it("exposes padding when stretching", () => {
    const layout = stretchLayout({ left: 16, right: 24, top: 8, bottom: 12 });
    const fields = authoringFieldsFromLayout(parent, layout);
    expect(fields.pinX).toBe(false);
    expect(fields.pinY).toBe(false);
    expect(fields.left).toBe(16);
    expect(fields.right).toBe(24);
    expect(fields.top).toBe(8);
    expect(fields.bottom).toBe(12);
  });

  it("treats a non-100 percent size as pinned size, not stretch insets", () => {
    const layout = pinLayout("left", "top", 160, 40);
    layout.widthUnit = "percent";
    layout.width = 50;
    const fields = authoringFieldsFromLayout(parent, layout);
    expect(fields.pinX).toBe(true);
    expect(fields.width).toBe(50);
  });

  it("converts px size to percent using the parent extent", () => {
    const layout = pinLayout("left", "top", 160, 40);
    const next = convertLayoutSize(layout, "width", "percent", parent);
    expect(next.widthUnit).toBe("percent");
    expect(next.width).toBe(20);
  });

  it("converts percent size to px using the parent extent", () => {
    const layout = pinLayout("left", "top", 50, 40);
    layout.widthUnit = "percent";
    const next = convertLayoutSize(layout, "width", "px", parent);
    expect(next.widthUnit).toBe("px");
    expect(next.width).toBe(400);
  });

  it("writes width when pinned", () => {
    const layout = pinLayout("center", "center", 200, 100);
    const next = applyAuthoringFields(layout, parent, { width: 300 });
    const rect = previewRect(parent, next);
    expect(rect.width).toBe(300);
  });

  it("writes padding when stretching", () => {
    const layout = stretchLayout();
    const next = applyAuthoringFields(layout, parent, { left: 40, right: 60 });
    const fields = authoringFieldsFromLayout(parent, next);
    expect(fields.left).toBe(40);
    expect(fields.right).toBe(60);
    expect(previewRect(parent, next).width).toBe(700);
  });
});

describe("resize", () => {
  it("grows the right edge without moving the left", () => {
    const layout = pinLayout("left", "top", 100, 40, 0, 0);
    const before = previewRect(parent, layout);
    const next = applyWidgetResize(layout, parent, { x: 20, y: 0 }, {
      right: true,
    });
    const rect = previewRect(parent, next);
    expect(rect.x).toBe(before.x);
    expect(rect.width).toBe(before.width + 20);
  });

  it("moves the top edge in GUI Y-down", () => {
    const layout = pinLayout("left", "top", 100, 40, 0, 100);
    const before = previewRect(parent, layout);
    const next = applyWidgetResize(layout, parent, { x: 0, y: -10 }, {
      top: true,
    });
    const rect = previewRect(parent, next);
    expect(rect.y).toBe(before.y - 10);
    expect(rect.height).toBe(before.height + 10);
  });
});

describe("default add layout", () => {
  it("pins a Button at parent center with a preferred size, not stretch-fill", () => {
    const layout = defaultAddLayout("Button");
    expect(layout.horizontalAlignment).toBe("center");
    expect(layout.verticalAlignment).toBe("center");
    expect(layout.widthUnit).toBe("px");
    const rect = previewRect(parent, layout);
    expect(rect.width).toBe(preferredWidgetSize("Button").width);
    expect(rect.height).toBe(preferredWidgetSize("Button").height);
    expect(rect.x + rect.width / 2).toBe(400);
  });

  it("authors StackPanel children with pixel size on the stack axis", () => {
    const vertical = defaultAddLayout("Button", 0, "StackPanel", true);
    expect(vertical.heightUnit).toBe("px");
    const horizontal = defaultAddLayout("Button", 0, "StackPanel", false);
    expect(horizontal.widthUnit).toBe("px");
  });

  it("staggers later siblings away from the shared center", () => {
    const first = defaultAddLayout("Button", 0);
    const second = defaultAddLayout("Checkbox", 1);
    expect(first.left).toBe(0);
    expect(second.left).toBe(48);
    expect(second.top).toBe(48);
  });

  it("marks box and grid parents as owning child layout", () => {
    expect(parentOwnsChildLayout("StackPanel")).toBe(true);
    expect(parentOwnsChildLayout("Grid")).toBe(true);
    expect(parentOwnsChildLayout("ScrollViewer")).toBe(false);
    expect(parentOwnsChildLayout("Canvas")).toBe(false);
    expect(parentOwnsChildLayout("Rectangle")).toBe(false);
  });

  it("refuses designer move/resize on the canvas root and fill-slot children", () => {
    const hud = createDefaultPlayHud("HUD");
    expect(widgetAllowsDesignerTransform(hud, hud.rootId)).toBe(false);
    expect(widgetAllowsDesignerTransform(hud, "stick")).toBe(true);
    const box = createWidget("box", "StackPanel", "Row");
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

describe("authoringParentRect", () => {
  it("insets Canvas children by Safe Area without a layout solver", () => {
    const hud = createDefaultUserInterface("HUD");
    const button = createWidget("play", "Button", "Play", pinLayout("left", "top", 80, 32));
    hud.widgets.canvas!.children = ["play"];
    hud.widgets.play = button;
    const parent = authoringParentRect(hud, "play", {
      viewport: { width: 800, height: 600 },
      safeArea: { left: 10, right: 20, top: 30, bottom: 40 },
    });
    expect(parent).toEqual({ x: 10, y: 30, width: 770, height: 530 });
  });

  it("uses the parent control guiRect for nested absolute widgets", () => {
    const hud = createDefaultUserInterface("HUD");
    const panel = createWidget("panel", "Rectangle", "Panel", pinLayout("left", "top", 200, 100));
    const label = createWidget("label", "TextBlock", "HP", pinLayout("left", "top", 80, 20));
    panel.children = ["label"];
    hud.widgets.canvas!.children = ["panel"];
    hud.widgets.panel = panel;
    hud.widgets.label = label;
    const parent = authoringParentRect(hud, "label", {
      viewport: { width: 800, height: 600 },
      safeArea: ZERO_INSETS,
      controls: [
        { id: "panel", guiRect: { x: 40, y: 50, width: 200, height: 100 } },
      ],
    });
    expect(parent).toEqual({ x: 40, y: 50, width: 200, height: 100 });
  });
});
