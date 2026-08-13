import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createDefaultPlayHud } from "@babylonslate/ui-runtime";
import { UiDesigner } from "./ui-designer";

function dispatchPointerEvent(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  init: {
    pointerId?: number;
    pointerType?: "touch" | "mouse" | "pen";
    clientX?: number;
    clientY?: number;
  } = {},
): void {
  const {
    pointerId = 1,
    pointerType = "touch",
    clientX = 0,
    clientY = 0,
  } = init;
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
  });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  target.dispatchEvent(event);
}

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    assetRegistry: { list: () => [], getByGuid: () => undefined },
    openDocuments: [],
    collectPlayUiLibrary: async () => ({}),
  }),
}));

afterEach(() => {
  cleanup();
});

function renderHud() {
  const onChange = vi.fn();
  const payload = createDefaultPlayHud("HUD") as unknown as Record<string, unknown>;
  render(
    <UiDesigner
      path="assets/HUD.ui.babasset"
      payload={payload}
      onChange={onChange}
    />,
  );
  return { onChange };
}

describe("UiDesigner", () => {
  it("exposes layout anchors, offsets, pivot, and padding in Details", () => {
    renderHud();
    expect(screen.getByTestId("property-row-anchor-min")).toBeTruthy();
    expect(screen.getByTestId("property-anchor-min-x")).toBeTruthy();
    expect(screen.getByTestId("property-row-anchor-max")).toBeTruthy();
    expect(screen.getByTestId("property-row-offset-min")).toBeTruthy();
    expect(screen.getByTestId("property-offset-min-x")).toBeTruthy();
    expect(screen.getByTestId("property-row-offset-max")).toBeTruthy();
    expect(screen.getByTestId("property-row-pivot")).toBeTruthy();
    expect(screen.getByTestId("property-pivot-x")).toBeTruthy();
    expect(screen.getByTestId("property-padding-left")).toBeTruthy();
    expect(screen.getByTestId("property-padding-right")).toBeTruthy();
    expect(screen.getByTestId("property-padding-top")).toBeTruthy();
    expect(screen.getByTestId("property-padding-bottom")).toBeTruthy();
  });

  it("drags a widget to write offsets under one undo merge key", () => {
    const { onChange } = renderHud();
    const stick = screen.getByTestId("ui-widget-stick");
    dispatchPointerEvent(stick, "pointerdown", { clientX: 10, clientY: 10 });
    dispatchPointerEvent(stick, "pointermove", { clientX: 55, clientY: 10 });
    expect(onChange).toHaveBeenCalled();
    const [next, mergeKey] = onChange.mock.calls.at(-1) as [
      Record<string, unknown>,
      string | undefined,
    ];
    expect(mergeKey).toMatch(/^ui-design-stroke:/);
    const widgets = next.widgets as Record<
      string,
      { layout: { offsetMin: { x: number }; offsetMax: { x: number } } }
    >;
    expect(widgets.stick.layout.offsetMin.x).toBeGreaterThan(-80);
    expect(widgets.stick.layout.offsetMax.x).toBeGreaterThan(80);
  });

  it("zooms the design canvas with the wheel and still selects widgets", () => {
    renderHud();
    const viewport = screen.getByTestId("ui-design-viewport");
    const canvas = screen.getByTestId("ui-design-canvas");
    expect(canvas.getAttribute("data-zoom")).toBe("1");
    fireEvent.wheel(viewport, { deltaY: -120, clientX: 80, clientY: 40 });
    expect(Number(canvas.getAttribute("data-zoom"))).toBeGreaterThan(1);
    fireEvent.click(screen.getByTestId("ui-widget-header"));
    expect(
      (screen.getByTestId("property-name") as HTMLInputElement).value,
    ).toBe("Title");
  });

  it("pans the design canvas with two pointers", () => {
    renderHud();
    const viewport = screen.getByTestId("ui-design-viewport");
    const canvas = screen.getByTestId("ui-design-canvas");
    act(() => {
      dispatchPointerEvent(viewport, "pointerdown", {
        pointerId: 1,
        clientX: 10,
        clientY: 10,
      });
      dispatchPointerEvent(viewport, "pointerdown", {
        pointerId: 2,
        clientX: 20,
        clientY: 10,
      });
      dispatchPointerEvent(viewport, "pointermove", {
        pointerId: 1,
        clientX: 50,
        clientY: 10,
      });
      dispatchPointerEvent(viewport, "pointermove", {
        pointerId: 2,
        clientX: 60,
        clientY: 10,
      });
    });
    expect(Number(canvas.getAttribute("data-pan-x"))).toBeGreaterThan(0);
  });
});
