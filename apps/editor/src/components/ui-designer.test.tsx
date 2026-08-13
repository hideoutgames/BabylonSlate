import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDefaultPlayHud, createWidget } from "@babylonslate/ui-runtime";
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

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    assetRegistry: {
      list: () => [
        {
          header: {
            guid: "tex-1",
            name: "Icon",
            type: "Texture",
            payload: {},
          },
          path: "assets/Icon.texture.babasset",
        },
        {
          header: {
            guid: "font-1",
            name: "Display",
            type: "Font",
            payload: { family: "Display Face" },
          },
          path: "assets/Display.font.babasset",
        },
      ],
      getByGuid: (guid: string) =>
        guid === "font-1"
          ? {
              header: {
                guid: "font-1",
                name: "Display",
                type: "Font",
                payload: { family: "Display Face" },
              },
              path: "assets/Display.font.babasset",
            }
          : guid === "tex-1"
            ? {
                header: { guid: "tex-1", name: "Icon", type: "Texture", payload: {} },
                path: "assets/Icon.texture.babasset",
              }
            : undefined,
    },
    openDocuments: [],
    collectPlayUiLibrary: async () => ({}),
    projectDocument: {
      settings: {
        input: {
          actions: [
            { name: "Jump", bindings: [] },
            { name: "Confirm", bindings: [] },
          ],
          axes: [{ name: "Move", bindings: [] }],
        },
      },
    },
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

  it("hosts a script palette and class members on the Logic tab", async () => {
    const { container } = render(
      <UiDesigner
        path="assets/HUD.ui.babasset"
        payload={createDefaultPlayHud("HUD") as unknown as Record<string, unknown>}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Logic" }));
    expect(screen.getByTestId("ui-logic-members")).toBeTruthy();
    expect(screen.getByTestId("class-add-variables")).toBeTruthy();
    expect(screen.getByTestId("class-add-events")).toBeTruthy();
    await waitFor(() => {
      expect(container.querySelector(".react-flow__pane")).not.toBeNull();
    });
    const pane = container.querySelector(".react-flow__pane");
    fireEvent.click(pane!);
    fireEvent.click(pane!);
    await waitFor(() => {
      expect(screen.getByTestId("node-palette-item-flow.event.beginPlay")).toBeTruthy();
    });
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

  it("picks an Image texture, Text font, and TouchButton action", async () => {
    const onChange = vi.fn();
    const payload = createDefaultPlayHud("HUD");
    payload.widgets.icon = createWidget("icon", "Image", "Icon");
    payload.widgets.jump = createWidget("jump", "TouchButton", "Jump");
    payload.widgets.canvas!.children = [
      ...payload.widgets.canvas!.children,
      "icon",
      "jump",
    ];
    render(
      <UiDesigner
        path="assets/HUD.ui.babasset"
        payload={payload as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByTestId("ui-widget-icon"));
    fireEvent.click(screen.getByTestId("property-image"));
    expect(await screen.findByTestId("search-item-tex-1")).toBeTruthy();
    fireEvent.click(screen.getByTestId("search-item-tex-1"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        widgets: expect.objectContaining({
          icon: expect.objectContaining({
            props: expect.objectContaining({ imageGuid: "tex-1" }),
          }),
        }),
      }),
    );

    fireEvent.click(screen.getByTestId("ui-widget-header"));
    fireEvent.click(screen.getByTestId("property-font"));
    expect(await screen.findByTestId("search-item-font-1")).toBeTruthy();
    fireEvent.click(screen.getByTestId("search-item-font-1"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        widgets: expect.objectContaining({
          header: expect.objectContaining({
            style: expect.objectContaining({ fontFamily: "Display Face" }),
          }),
        }),
      }),
    );

    fireEvent.click(screen.getByTestId("ui-widget-jump"));
    expect(screen.getByTestId("property-action").tagName).not.toBe("INPUT");
    expect(screen.getByTestId("property-visual-override")).toBeTruthy();
  });

  it("prompts for class member names with NamePromptDialog", async () => {
    const onChange = vi.fn();
    render(
      <UiDesigner
        path="assets/HUD.ui.babasset"
        payload={createDefaultPlayHud("HUD") as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Logic" }));
    fireEvent.click(screen.getByTestId("class-add-functions"));
    fireEvent.change(screen.getByTestId("name-prompt-input"), {
      target: { value: "Jump" },
    });
    fireEvent.click(screen.getByTestId("name-prompt-confirm"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        logic: expect.objectContaining({
          members: expect.arrayContaining([
            expect.objectContaining({ kind: "function", name: "Jump" }),
          ]),
        }),
      }),
    );
  });
});
