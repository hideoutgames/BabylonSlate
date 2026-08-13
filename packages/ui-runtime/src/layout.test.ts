import { describe, expect, it } from "vitest";
import {
  computeAnchoredRect,
  createDefaultPlayHud,
  createDefaultUserInterface,
  createWidget,
  insetRect,
  layoutUserInterface,
  normalizeLayout,
  pinLayout,
  pivotPoint,
  stretchLayout,
  toGuiRect,
  WIDGET_KINDS,
} from "./index";

describe("anchored layout", () => {
  const parent = { x: 0, y: 0, width: 1920, height: 1080 };

  it("pins when anchors are equal", () => {
    const rect = computeAnchoredRect(
      parent,
      pinLayout({ x: 0.5, y: 0.5 }, { x: 200, y: 100 }),
    );
    expect(rect).toEqual({ x: 860, y: 490, width: 200, height: 100 });
  });

  it("stretches when anchors differ", () => {
    const rect = computeAnchoredRect(parent, stretchLayout({
      left: 16,
      right: 16,
      top: 24,
      bottom: 8,
    }));
    expect(rect).toEqual({ x: 16, y: 8, width: 1888, height: 1048 });
  });

  it("keeps pivot separate from the computed rect", () => {
    const layout = pinLayout({ x: 0, y: 0 }, { x: 100, y: 40 }, { x: 0, y: 0 });
    const rect = computeAnchoredRect(parent, layout);
    expect(rect).toEqual({ x: 0, y: 0, width: 100, height: 40 });
    expect(pivotPoint(rect, layout.pivot)).toEqual({ x: 0, y: 0 });
    expect(pivotPoint(rect, { x: 1, y: 1 })).toEqual({ x: 100, y: 40 });
  });

  it("treats safe-area insets as a parent rect", () => {
    const safe = insetRect(parent, {
      left: 0,
      right: 0,
      top: 24,
      bottom: 20,
    });
    expect(safe).toEqual({ x: 0, y: 20, width: 1920, height: 1036 });
    const rect = computeAnchoredRect(safe, stretchLayout());
    expect(rect).toEqual(safe);
  });

  it("clamps anchors to [0, 1]", () => {
    const layout = normalizeLayout({
      anchorMin: { x: -1, y: 2 },
      anchorMax: { x: 3, y: -0.5 },
      offsetMin: { x: 0, y: 0 },
      offsetMax: { x: 0, y: 0 },
      pivot: { x: 1.5, y: -2 },
    });
    expect(layout.anchorMin).toEqual({ x: 0, y: 1 });
    expect(layout.anchorMax).toEqual({ x: 1, y: 1 });
    expect(layout.pivot).toEqual({ x: 1, y: 0 });
  });

  it("keeps max >= min when a raw max is NaN", () => {
    const layout = normalizeLayout({
      anchorMin: { x: 0.25, y: 0.1 },
      anchorMax: { x: Number.NaN, y: Number.NaN },
      offsetMin: { x: 0, y: 0 },
      offsetMax: { x: 0, y: 0 },
      pivot: { x: 0.5, y: 0.5 },
    });
    expect(layout.anchorMax.x).toBeGreaterThanOrEqual(layout.anchorMin.x);
    expect(layout.anchorMax.y).toBeGreaterThanOrEqual(layout.anchorMin.y);
  });

  it("converts engine Y-up rects to Babylon GUI top-left", () => {
    const gui = toGuiRect({ x: 10, y: 20, width: 30, height: 40 }, 100);
    expect(gui).toEqual({ x: 10, y: 40, width: 30, height: 40 });
  });
});

describe("container layout", () => {
  it("lays HorizontalBox children left to right", () => {
    const doc = createDefaultUserInterface();
    const box = createWidget("hbox", "HorizontalBox", "Row");
    box.props.gap = 10;
    const a = createWidget("a", "Button", "A", pinLayout({ x: 0, y: 0 }, { x: 80, y: 32 }));
    a.props.text = "A";
    const b = createWidget("b", "Button", "B", pinLayout({ x: 0, y: 0 }, { x: 80, y: 32 }));
    b.props.text = "B";
    box.children = ["a", "b"];
    doc.widgets.canvas!.children = ["hbox"];
    doc.widgets.hbox = box;
    doc.widgets.a = a;
    doc.widgets.b = b;

    const result = layoutUserInterface(doc, { width: 1920, height: 1080 });
    const row = result.tree?.children[0];
    expect(row?.children[0]?.rect.x).toBeLessThan(row?.children[1]?.rect.x ?? 0);
    expect(row?.children[1]?.rect.x).toBe(
      (row?.children[0]?.rect.x ?? 0) + (row?.children[0]?.rect.width ?? 0) + 10,
    );
  });

  it("lays VerticalBox children top to bottom in engine space", () => {
    const doc = createDefaultUserInterface();
    const box = createWidget("vbox", "VerticalBox", "Col");
    box.props.gap = 4;
    const a = createWidget("a", "Text", "A");
    a.props.text = "A";
    const b = createWidget("b", "Text", "B");
    b.props.text = "B";
    box.children = ["a", "b"];
    doc.widgets.canvas!.children = ["vbox"];
    doc.widgets.vbox = box;
    doc.widgets.a = a;
    doc.widgets.b = b;

    const result = layoutUserInterface(doc, { width: 1920, height: 1080 });
    const col = result.tree?.children[0];
    const first = col?.children[0]?.rect;
    const second = col?.children[1]?.rect;
    expect(first && second).toBeTruthy();
    expect((first?.y ?? 0) + (first?.height ?? 0)).toBeGreaterThan(second?.y ?? 0);
  });

  it("lays Grid children into cells and SizeBox to a preferred size", () => {
    const doc = createDefaultUserInterface();
    const grid = createWidget("grid", "Grid", "Grid", stretchLayout());
    grid.props = { columns: 2, rows: 1, gap: 10 };
    const a = createWidget("a", "Button", "A");
    const b = createWidget("b", "Button", "B");
    grid.children = ["a", "b"];
    const box = createWidget("size", "SizeBox", "Box");
    box.props = { width: 40, height: 20 };
    doc.widgets.canvas!.children = ["grid", "size"];
    doc.widgets.grid = grid;
    doc.widgets.a = a;
    doc.widgets.b = b;
    doc.widgets.size = box;
    const result = layoutUserInterface(doc, { width: 200, height: 100 });
    const row = result.tree?.children.find((node) => node.id === "grid");
    expect(row?.children[1]?.rect.x).toBeGreaterThan(row?.children[0]?.rect.x ?? 0);
    const sized = result.tree?.children.find((node) => node.id === "size");
    expect(sized?.children[0]).toBeUndefined();
  });

  it("lays Overlay children with anchors inside the overlay", () => {
    const doc = createDefaultUserInterface();
    const overlay = createWidget("over", "Overlay");
    const child = createWidget(
      "c",
      "Text",
      "Hi",
      pinLayout({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 0 }),
    );
    overlay.children = ["c"];
    doc.widgets.canvas!.children = ["over"];
    doc.widgets.over = overlay;
    doc.widgets.c = child;
    const result = layoutUserInterface(doc, { width: 100, height: 100 });
    const overlayNode = result.tree?.children[0];
    const childNode = overlayNode?.children[0];
    expect(childNode?.rect.width).toBe(10);
    expect(childNode?.rect.height).toBe(10);
    expect(childNode?.rect.x).toBe(overlayNode?.rect.x);
    expect(childNode?.rect.y).toBe(overlayNode?.rect.y);
  });
});

describe("default play HUD", () => {
  it("seeds a title and move stick for every widget kind catalog", () => {
    expect(WIDGET_KINDS).toContain("TouchJoystick");
    expect(WIDGET_KINDS).toContain("Grid");
    expect(WIDGET_KINDS).toContain("UserInterface");
    const hud = createDefaultPlayHud("HUD");
    expect(hud.viewportLayer).toBe(true);
    expect(hud.widgets.stick?.kind).toBe("TouchJoystick");
    expect(hud.widgets.header?.props.text).toBe("Score");
    expect(hud.desiredSize).toEqual(hud.designResolution);
    for (const kind of WIDGET_KINDS) {
      expect(createWidget(`id-${kind}`, kind).kind).toBe(kind);
    }
  });

  it("defaults blank UserInterface assets to a reusable desired size", () => {
    expect(createDefaultUserInterface().desiredSize).toEqual({
      width: 400,
      height: 300,
    });
  });
});

describe("nested UserInterface layout", () => {
  it("lays a nested UserInterface into the host slot using its desired size", () => {
    const chip = createDefaultUserInterface("Chip");
    chip.desiredSize = { width: 80, height: 20 };
    const label = createWidget("label", "Text", "HP");
    label.props.text = "HP";
    chip.widgets.canvas!.children = ["label"];
    chip.widgets.label = label;

    const hud = createDefaultUserInterface("HUD");
    const host = createWidget(
      "chip",
      "UserInterface",
      "Chip",
      pinLayout({ x: 0, y: 1 }, { x: 80, y: 20 }, { x: 0, y: 1 }),
    );
    host.nestedUiGuid = "chip-guid";
    hud.widgets.canvas!.children = ["chip"];
    hud.widgets.chip = host;

    const result = layoutUserInterface(
      hud,
      { width: 200, height: 100 },
      { resolveNested: (guid) => (guid === "chip-guid" ? chip : null) },
    );
    const nested = result.tree?.children[0];
    expect(nested?.kind).toBe("UserInterface");
    expect(nested?.children[0]?.name).toBe("Canvas");
    const text = nested?.children[0]?.children[0];
    expect(text?.name).toBe("HP");
    expect(text?.id).toBe("chip/label");
  });
});
