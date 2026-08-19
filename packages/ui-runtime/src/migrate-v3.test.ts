import { describe, expect, it } from "vitest";
import { migrateUserInterfaceV3 } from "./migrate-v3";
import { canonicalWidgetKind } from "./types";

describe("canonicalWidgetKind", () => {
  it("maps v2 aliases onto Babylon kinds", () => {
    expect(canonicalWidgetKind("HorizontalBox")).toBe("StackPanel");
    expect(canonicalWidgetKind("VerticalBox")).toBe("StackPanel");
    expect(canonicalWidgetKind("ScrollBox")).toBe("ScrollViewer");
    expect(canonicalWidgetKind("Text")).toBe("TextBlock");
    expect(canonicalWidgetKind("TextInput")).toBe("InputText");
    expect(canonicalWidgetKind("CheckBox")).toBe("Checkbox");
    expect(canonicalWidgetKind("Border")).toBe("Rectangle");
    expect(canonicalWidgetKind("Overlay")).toBe("Rectangle");
    expect(canonicalWidgetKind("SizeBox")).toBe("Rectangle");
    expect(canonicalWidgetKind("Spacer")).toBe("Container");
    expect(canonicalWidgetKind("Button")).toBe("Button");
    expect(canonicalWidgetKind("unknown")).toBe("Rectangle");
  });
});

describe("migrateUserInterfaceV3", () => {
  it("rewrites v2 kinds, units, and stack orientation", () => {
    const next = migrateUserInterfaceV3({
      name: "HUD",
      widgets: {
        canvas: { id: "canvas", kind: "Canvas", children: ["row", "label"] },
        row: {
          id: "row",
          kind: "HorizontalBox",
          children: ["btn"],
          props: { gap: 4 },
          layout: {
            horizontalAlignment: "left",
            verticalAlignment: "top",
            width: 100,
            height: 40,
            widthUnit: "percent",
            heightUnit: "px",
            left: 0,
            top: 8,
          },
        },
        btn: {
          id: "btn",
          kind: "Button",
          layout: {
            horizontalAlignment: "left",
            verticalAlignment: "top",
            width: 50,
            height: 100,
            widthUnit: "percent",
            heightUnit: "percent",
            left: 0,
            top: 0,
          },
        },
        label: { id: "label", kind: "Text", props: { text: "Hi" } },
      },
    });
    const widgets = next.widgets as Record<string, Record<string, unknown>>;
    expect(widgets.row?.kind).toBe("StackPanel");
    expect((widgets.row?.props as Record<string, unknown>).isVertical).toBe(false);
    expect(widgets.label?.kind).toBe("TextBlock");
    const rowLayout = widgets.row?.layout as Record<string, unknown>;
    expect(rowLayout.leftUnit).toBe("px");
    expect(rowLayout.topUnit).toBe("px");
    const btnLayout = widgets.btn?.layout as Record<string, unknown>;
    expect(btnLayout.widthUnit).toBe("px");
  });

  it("builds Grid track defs and per-child cells", () => {
    const next = migrateUserInterfaceV3({
      widgets: {
        canvas: { id: "canvas", kind: "Canvas", children: ["grid"] },
        grid: {
          id: "grid",
          kind: "Grid",
          children: ["a", "b"],
          props: { columns: 2, rows: 1 },
        },
        a: { id: "a", kind: "Button" },
        b: { id: "b", kind: "Button" },
      },
    });
    const widgets = next.widgets as Record<string, Record<string, unknown>>;
    const props = widgets.grid?.props as Record<string, unknown>;
    expect(props.gridColumns).toEqual([
      { value: 1, isPixel: false },
      { value: 1, isPixel: false },
    ]);
    expect((widgets.a as { gridColumn?: number; gridRow?: number }).gridColumn).toBe(0);
    expect((widgets.b as { gridColumn?: number; gridRow?: number }).gridColumn).toBe(1);
  });

  it("moves style.padding onto layout.padding when layout padding is empty", () => {
    const next = migrateUserInterfaceV3({
      widgets: {
        canvas: {
          id: "canvas",
          kind: "Border",
          layout: {
            horizontalAlignment: "left",
            verticalAlignment: "top",
            width: 100,
            height: 100,
            widthUnit: "percent",
            heightUnit: "percent",
            left: 0,
            top: 0,
            padding: { left: 0, right: 0, top: 0, bottom: 0 },
          },
          style: { padding: { left: 8, right: 4, top: 2, bottom: 6 } },
        },
      },
    });
    const canvas = (next.widgets as Record<string, { kind: string; layout: { padding: { left: number } }; style: Record<string, unknown> }>)
      .canvas;
    expect(canvas?.kind).toBe("Rectangle");
    expect(canvas?.layout.padding.left).toBe(8);
    expect(canvas?.style.padding).toBeUndefined();
  });

  it("migrates Button visualOverride off and Touch skins onto nestedUiGuid", () => {
    const next = migrateUserInterfaceV3({
      widgets: {
        canvas: { id: "canvas", kind: "Canvas", children: ["btn", "stick"] },
        btn: {
          id: "btn",
          kind: "Button",
          visualOverrideGuid: "art-guid",
          props: { text: "Play" },
        },
        stick: {
          id: "stick",
          kind: "TouchJoystick",
          visualOverrideGuid: "skin-guid",
        },
      },
    });
    const widgets = next.widgets as Record<string, Record<string, unknown>>;
    expect(widgets.btn?.visualOverrideGuid).toBeNull();
    expect((widgets.btn?.style as Record<string, unknown>).imageGuid).toBe("art-guid");
    expect(widgets.stick?.nestedUiGuid).toBe("skin-guid");
    expect(widgets.stick?.visualOverrideGuid).toBeNull();
  });
});
