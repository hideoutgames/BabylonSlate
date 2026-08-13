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
    readAssetChunk: async () => null,
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
  it("exposes alignment, left/top, and size in Details", () => {
    renderHud();
    expect(screen.getByTestId("ui-anchor-preset")).toBeTruthy();
    expect(screen.getByTestId("property-left")).toBeTruthy();
    expect(screen.getByTestId("property-top")).toBeTruthy();
    expect(screen.getByTestId("property-width")).toBeTruthy();
    expect(screen.getByTestId("property-height")).toBeTruthy();
    expect(screen.getByTestId("property-row-transform-center")).toBeTruthy();
    expect(screen.getByTestId("property-padding-left")).toBeTruthy();
    fireEvent.click(screen.getByTestId("ui-widget-header"));
    expect(screen.getByTestId("property-left")).toBeTruthy();
    expect(screen.getByTestId("property-top")).toBeTruthy();
    expect(screen.getByTestId("property-width")).toBeTruthy();
    expect(screen.getByTestId("property-height")).toBeTruthy();
    expect(screen.queryByTestId("property-offset-min-x")).toBeNull();
    fireEvent.click(screen.getByTestId("ui-widget-stick"));
    expect(screen.getByTestId("ui-resize-se")).toBeTruthy();
    expect(screen.getByTestId("ui-gizmo-canvas")).toBeTruthy();
  });

  it("drags a widget to write left/top under one undo merge key", () => {
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
      { layout: { left: number; top: number } }
    >;
    expect(widgets.stick.layout.left).toBeGreaterThan(40);
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

  it("adds a pinned Button from the widget catalog", () => {
    const { onChange } = renderHud();
    fireEvent.click(screen.getByTestId("ui-add-widget"));
    fireEvent.click(screen.getByTestId("ui-add-widget-Button"));
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls.at(-1)![0] as {
      widgets: Record<string, { kind: string; layout: { horizontalAlignment: string; verticalAlignment: string } }>;
    };
    const button = Object.values(next.widgets).find((row) => row.kind === "Button");
    expect(button).toBeTruthy();
    expect(button!.layout.horizontalAlignment).toBe("center");
    expect(button!.layout.verticalAlignment).toBe("center");
  });

  it("deletes a widget from the hierarchy context menu", () => {
    const { onChange } = renderHud();
    fireEvent.contextMenu(screen.getByTestId("tree-row-stick"));
    fireEvent.click(screen.getByTestId("ui-widget-delete"));
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls.at(-1)![0] as {
      widgets: Record<string, unknown>;
    };
    expect(next.widgets.stick).toBeUndefined();
  });

  it("does not expose Desired Width and Height inputs", () => {
    renderHud();
    expect(screen.queryByTestId("ui-desired-width")).toBeNull();
    expect(screen.queryByTestId("ui-desired-height")).toBeNull();
    fireEvent.click(screen.getByTestId("ui-device-preset"));
    fireEvent.click(screen.getByTestId("ui-preset-desired"));
    expect(screen.queryByTestId("ui-desired-width")).toBeNull();
    expect(screen.queryByTestId("ui-desired-height")).toBeNull();
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
    fireEvent.click(screen.getByTestId("class-add-member"));
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
    fireEvent.click(screen.getByTestId("class-add-member"));
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
