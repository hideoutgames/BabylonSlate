import { describe, expect, it } from "vitest";
import {
  DEFAULT_DESIRED_SIZE,
  createDefaultPlayHud,
  createDefaultUserInterface,
  createWidget,
  contentDesiredSize,
  defaultAddLayout,
  insetRect,
  layoutUserInterface,
  normalizeLayout,
  pinLayout,
  pivotPoint,
  previewRect,
  stretchLayout,
  toGuiRect,
  WIDGET_KINDS,
} from "./index";

describe("Babylon-native layout", () => {
  const parent = { x: 0, y: 0, width: 1920, height: 1080 };

  it("pins a centered pixel widget", () => {
    const rect = previewRect(parent, pinLayout("center", "center", 200, 100));
    expect(rect).toEqual({ x: 860, y: 490, width: 200, height: 100 });
  });

  it("stretches with padding", () => {
    const rect = previewRect(
      parent,
      stretchLayout({
        left: 16,
        right: 16,
        top: 24,
        bottom: 8,
      }),
    );
    expect(rect).toEqual({ x: 16, y: 24, width: 1888, height: 1048 });
  });

  it("keeps transformCenter separate from the computed rect", () => {
    const layout = pinLayout("left", "top", 100, 40, 0, 0);
    const rect = previewRect(parent, layout);
    expect(rect).toEqual({ x: 0, y: 0, width: 100, height: 40 });
    expect(pivotPoint(rect, layout.transformCenter)).toEqual({ x: 50, y: 20 });
    expect(pivotPoint(rect, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });

  it("treats safe-area insets as a padded parent", () => {
    const safe = insetRect(parent, {
      left: 0,
      right: 0,
      top: 24,
      bottom: 20,
    });
    expect(safe).toEqual({ x: 0, y: 24, width: 1920, height: 1036 });
    const rect = previewRect(safe, stretchLayout());
    expect(rect).toEqual(safe);
  });

  it("clamps transformCenter to [0, 1]", () => {
    const layout = normalizeLayout({
      ...pinLayout("left", "top", 10, 10),
      transformCenter: { x: 1.5, y: -2 },
    });
    expect(layout.transformCenter).toEqual({ x: 1, y: 0 });
  });

  it("leaves GUI rects in top-left space", () => {
    const gui = toGuiRect({ x: 10, y: 20, width: 30, height: 40 });
    expect(gui).toEqual({ x: 10, y: 20, width: 30, height: 40 });
  });
});

describe("container layout", () => {
  it("lays HorizontalBox children left to right", () => {
    const doc = createDefaultUserInterface();
    const box = createWidget("hbox", "StackPanel", "Row");
    box.props.gap = 10;
    box.props.isVertical = false;
    const a = createWidget("a", "Button", "A", pinLayout("left", "top", 80, 32));
    a.props.text = "A";
    const b = createWidget("b", "Button", "B", pinLayout("left", "top", 80, 32));
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

  it("lays VerticalBox children top to bottom in GUI space", () => {
    const doc = createDefaultUserInterface();
    const box = createWidget("vbox", "StackPanel", "Col");
    box.props.gap = 4;
    const a = createWidget("a", "TextBlock", "A");
    a.props.text = "A";
    const b = createWidget("b", "TextBlock", "B");
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
    expect(second?.y ?? 0).toBeGreaterThan((first?.y ?? 0) + (first?.height ?? 0) - 0.001);
  });

  it("lays Grid children into cells and SizeBox to a preferred size", () => {
    const doc = createDefaultUserInterface();
    const grid = createWidget("grid", "Grid", "Grid", stretchLayout());
    grid.props = { columns: 2, rows: 1, gap: 10 };
    const a = createWidget("a", "Button", "A");
    const b = createWidget("b", "Button", "B");
    grid.children = ["a", "b"];
    const box = createWidget("size", "Rectangle", "Box");
    box.props = { width: 40, height: 20 };
    doc.widgets.canvas!.children = ["grid", "size"];
    doc.widgets.grid = grid;
    doc.widgets.a = a;
    doc.widgets.b = b;
    doc.widgets.size = box;
    const result = layoutUserInterface(doc, { width: 1920, height: 1080 });
    const row = result.tree?.children.find((node) => node.id === "grid");
    expect(row?.children[1]?.rect.x).toBeGreaterThan(row?.children[0]?.rect.x ?? 0);
    const sized = result.tree?.children.find((node) => node.id === "size");
    expect(sized?.children[0]).toBeUndefined();
  });

  it("lays Overlay children with alignment inside the overlay", () => {
    const doc = createDefaultUserInterface();
    const overlay = createWidget("over", "Rectangle");
    const child = createWidget(
      "c", "TextBlock",
      "Hi",
      pinLayout("left", "top", 10, 10, 0, 0),
    );
    overlay.children = ["c"];
    doc.widgets.canvas!.children = ["over"];
    doc.widgets.over = overlay;
    doc.widgets.c = child;
    const result = layoutUserInterface(doc, { width: 1920, height: 1080 });
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
    expect(WIDGET_KINDS).toContain("Material");
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

  it("sizes Desired to content instead of the authored canvas", () => {
    expect(contentDesiredSize(createDefaultUserInterface())).toEqual(
      DEFAULT_DESIRED_SIZE,
    );
    const chip = createDefaultUserInterface("Chip");
    chip.desiredSize = { width: 1920, height: 1080 };
    const label = createWidget(
      "label", "TextBlock",
      "HP",
      pinLayout("left", "top", 80, 20, 8, 4),
    );
    label.props.text = "HP";
    chip.widgets.canvas!.children = ["label"];
    chip.widgets.label = label;
    expect(contentDesiredSize(chip)).toEqual({ width: 88, height: 24 });
    expect(contentDesiredSize(createDefaultPlayHud())).toEqual({
      width: 200,
      height: 160,
    });
  });

  it("sizes Desired so a center-aligned staggered widget stays inside the frame", () => {
    const doc = createDefaultUserInterface("HUD");
    const button = createWidget(
      "play",
      "Button",
      "Play",
      defaultAddLayout("Button", 1),
    );
    button.props.text = "Play";
    doc.widgets.canvas!.children = ["play"];
    doc.widgets.play = button;
    const size = contentDesiredSize(doc);
    const laid = layoutUserInterface(doc, size, { designSpace: true });
    const child = laid.tree?.children[0]?.rect;
    expect(child).toBeDefined();
    expect(child!.x).toBeGreaterThanOrEqual(0);
    expect(child!.y).toBeGreaterThanOrEqual(0);
    expect(child!.x + child!.width).toBeLessThanOrEqual(size.width + 0.01);
    expect(child!.y + child!.height).toBeLessThanOrEqual(size.height + 0.01);
    expect(size.width).toBeGreaterThan(200);
    expect(size.height).toBeGreaterThan(80);
  });
});

describe("nested UserInterface layout", () => {
  it("lays a nested UserInterface into the host slot using its content size", () => {
    const chip = createDefaultUserInterface("Chip");
    chip.desiredSize = { width: 1920, height: 1080 };
    const label = createWidget(
      "label", "TextBlock",
      "HP",
      pinLayout("left", "top", 80, 20),
    );
    label.props.text = "HP";
    chip.widgets.canvas!.children = ["label"];
    chip.widgets.label = label;

    const hud = createDefaultUserInterface("HUD");
    const host = createWidget(
      "chip",
      "UserInterface",
      "Chip",
      pinLayout("left", "top", 80, 20, 0, 0),
    );
    host.nestedUiGuid = "chip-guid";
    hud.widgets.canvas!.children = ["chip"];
    hud.widgets.chip = host;

    const result = layoutUserInterface(
      hud,
      { width: 1920, height: 1080 },
      { resolveNested: (guid) => (guid === "chip-guid" ? chip : null) },
    );
    const nested = result.tree?.children[0];
    expect(nested?.kind).toBe("UserInterface");
    expect(nested?.children[0]?.name).toBe("Canvas");
    expect(nested?.children[0]?.rect).toMatchObject({ width: 80, height: 20 });
    const text = nested?.children[0]?.children[0];
    expect(text?.name).toBe("HP");
    expect(text?.id).toBe("chip/label");
  });

  it("lays a visualOverrideGuid as a nested GUI subtree", () => {
    const skin = createDefaultUserInterface("Skin");
    const art = createWidget("art", "Image", "Art");
    skin.widgets.canvas!.children = ["art"];
    skin.widgets.art = art;

    const hud = createDefaultUserInterface("HUD");
    const button = createWidget(
      "jump",
      "TouchButton",
      "Jump",
      pinLayout("left", "top", 72, 72),
    );
    button.visualOverrideGuid = "skin-guid";
    hud.widgets.canvas!.children = ["jump"];
    hud.widgets.jump = button;

    const result = layoutUserInterface(
      hud,
      { width: 1920, height: 1080 },
      { resolveNested: (guid) => (guid === "skin-guid" ? skin : null) },
    );
    const host = result.tree?.children[0];
    expect(host?.kind).toBe("TouchButton");
    expect(host?.children[0]?.name).toBe("Canvas");
    expect(host?.children[0]?.children[0]?.name).toBe("Art");
    expect(host?.children[0]?.children[0]?.id).toBe("jump/art");
  });
});
