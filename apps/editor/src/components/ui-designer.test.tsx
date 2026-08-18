import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createDefaultPlayHud, createWidget } from "@babylonslate/ui-runtime";
import { resetProjectUiAssets } from "../lib/project-ui-asset-cache";
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

function widgetCenter(target: HTMLElement): { x: number; y: number } {
  const canvas = screen.getByTestId("ui-design-canvas");
  const canvasWidth = Number.parseFloat(canvas.style.width);
  const canvasHeight = Number.parseFloat(canvas.style.height);
  const zoom = Number(canvas.getAttribute("data-zoom"));
  const panX = Number(canvas.getAttribute("data-pan-x"));
  const panY = Number(canvas.getAttribute("data-pan-y"));
  const left = Number.parseFloat(target.style.left) / 100;
  const top = Number.parseFloat(target.style.top) / 100;
  const width = Number.parseFloat(target.style.width) / 100;
  const height = Number.parseFloat(target.style.height) / 100;
  return {
    x: panX + (left + width / 2) * canvasWidth * zoom,
    y: panY + (top + height / 2) * canvasHeight * zoom,
  };
}

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const { openLiveEditorUtility } = vi.hoisted(() => ({
  openLiveEditorUtility: vi.fn(),
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    openLiveEditorUtility,
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
        {
          header: {
            guid: "hud-1",
            name: "HUD",
            type: "UserInterface",
            payload: {},
          },
          path: "assets/HUD.ui.babasset",
        },
        {
          header: {
            guid: "eui-1",
            name: "SceneTools",
            type: "EditorUtilityInterface",
            payload: { dockKind: "scene" },
          },
          path: "assets/SceneTools.eui.babasset",
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
          : guid === "hud-1"
            ? {
                header: {
                  guid: "hud-1",
                  name: "HUD",
                  type: "UserInterface",
                  payload: {},
                },
                path: "assets/HUD.ui.babasset",
              }
            : guid === "eui-1"
              ? {
                  header: {
                    guid: "eui-1",
                    name: "SceneTools",
                    type: "EditorUtilityInterface",
                    payload: { dockKind: "scene" },
                  },
                  path: "assets/SceneTools.eui.babasset",
                }
              : guid === "tex-1"
                ? {
                    header: {
                      guid: "tex-1",
                      name: "Icon",
                      type: "Texture",
                      payload: {},
                    },
                    path: "assets/Icon.texture.babasset",
                  }
                : undefined,
    },
    openDocuments: [],
    collectPlayUiLibrary: async () => ({}),
    projectName: "Demo",
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
  resetProjectUiAssets();
  openLiveEditorUtility.mockReset();
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

  it("drags a widget to write left/top once on pointer up", () => {
    const { onChange } = renderHud();
    const stick = screen.getByTestId("ui-widget-stick");
    const start = widgetCenter(stick);
    dispatchPointerEvent(stick, "pointerdown", {
      clientX: start.x,
      clientY: start.y,
    });
    dispatchPointerEvent(stick, "pointermove", {
      clientX: start.x + 45,
      clientY: start.y,
    });
    expect(onChange).not.toHaveBeenCalled();
    dispatchPointerEvent(stick, "pointerup", {
      clientX: start.x + 45,
      clientY: start.y,
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    const [next] = onChange.mock.calls[0] as [Record<string, unknown>];
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
    const button = Object.values(next.widgets).find((row) => row.kind === "Button") as
      | { layout: { horizontalAlignment: string; verticalAlignment: string }; style?: { background?: string } }
      | undefined;
    expect(button).toBeTruthy();
    expect(button!.layout.horizontalAlignment).toBe("center");
    expect(button!.layout.verticalAlignment).toBe("center");
    expect(button!.style?.background).toBe("#333333");
  });

  it("deletes a widget from the hierarchy settings menu", () => {
    const { onChange } = renderHud();
    fireEvent.click(screen.getByTestId("ui-widget-menu-stick"));
    fireEvent.click(screen.getByTestId("ui-widget-delete"));
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls.at(-1)![0] as {
      widgets: Record<string, unknown>;
    };
    expect(next.widgets.stick).toBeUndefined();
  });

  it("toggles Visible from the hierarchy settings menu", () => {
    const { onChange } = renderHud();
    fireEvent.click(screen.getByTestId("ui-widget-menu-stick"));
    fireEvent.click(screen.getByTestId("ui-widget-visible-stick"));
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls.at(-1)![0] as {
      widgets: Record<string, { visible: boolean }>;
    };
    expect(next.widgets.stick.visible).toBe(false);
  });

  it("does not open Duplicate or Delete from a row context menu", () => {
    renderHud();
    fireEvent.contextMenu(screen.getByTestId("tree-row-stick"));
    expect(screen.queryByTestId("ui-widget-delete")).toBeNull();
    expect(screen.queryByTestId("ui-widget-duplicate")).toBeNull();
  });

  it("disables Duplicate and Delete on the Canvas root menu", () => {
    renderHud();
    fireEvent.click(screen.getByTestId("ui-widget-menu-canvas"));
    expect(screen.getByTestId("ui-widget-visible-canvas")).toBeTruthy();
    expect(screen.queryByTestId("ui-widget-ignore-safe-area-canvas")).toBeNull();
    expect(
      screen.getByTestId("ui-widget-delete").hasAttribute("data-disabled"),
    ).toBe(true);
    expect(
      screen.getByTestId("ui-widget-duplicate").hasAttribute("data-disabled"),
    ).toBe(true);
  });

  it("toggles Ignore Safe Area from the hierarchy settings menu for Canvas children", () => {
    const { onChange } = renderHud();
    fireEvent.click(screen.getByTestId("ui-widget-menu-stick"));
    fireEvent.click(screen.getByTestId("ui-widget-ignore-safe-area-stick"));
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls.at(-1)![0] as {
      widgets: Record<string, { ignoreSafeArea?: boolean }>;
    };
    expect(next.widgets.stick.ignoreSafeArea).toBe(true);
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

  it("hosts Designer Hierarchy, Design, and Details without a Logic strip", () => {
    renderHud();
    expect(screen.getByTestId("ui-hierarchy-panel")).toBeTruthy();
    expect(screen.getByTestId("ui-design-panel")).toBeTruthy();
    expect(screen.getByTestId("ui-details-panel")).toBeTruthy();
    expect(screen.queryByTestId("ui-logic-members")).toBeNull();
    expect(screen.queryByTestId("ui-logic-panel")).toBeNull();
    expect(screen.queryByTestId("class-add-functions")).toBeNull();
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
    const iconBefore = screen.getByTestId("ui-widget-icon");
    const beforeX = iconBefore.getAttribute("data-gui-x");
    const beforeY = iconBefore.getAttribute("data-gui-y");
    fireEvent.click(screen.getByTestId("search-item-tex-1"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        widgets: expect.objectContaining({
          icon: expect.objectContaining({
            props: expect.objectContaining({ imageGuid: "tex-1" }),
            layout: payload.widgets.icon!.layout,
          }),
        }),
      }),
    );
    expect(screen.getByTestId("ui-widget-icon").getAttribute("data-gui-x")).toBe(
      beforeX,
    );
    expect(screen.getByTestId("ui-widget-icon").getAttribute("data-gui-y")).toBe(
      beforeY,
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

  it("does not show Open Live on a UserInterface Design toolbar", () => {
    renderHud();
    expect(screen.queryByTestId("ui-open-live")).toBeNull();
  });

  it("opens the live Editor Utility for the current EditorUtilityInterface", () => {
    render(
      <UiDesigner
        path="assets/SceneTools.eui.babasset"
        payload={{
          ...(createDefaultPlayHud("HUD") as unknown as Record<string, unknown>),
          dockKind: "scene",
        }}
        onChange={vi.fn()}
        editorUtilityInterface
      />,
    );
    fireEvent.click(screen.getByTestId("ui-open-live"));
    expect(openLiveEditorUtility).toHaveBeenCalledWith("eui-1");
  });

  it("round-trips EditorUtilityInterface dockKind in Settings", () => {
    const onChange = vi.fn();
    render(
      <UiDesigner
        path="assets/SceneTools.eui.babasset"
        payload={{
          ...(createDefaultPlayHud("HUD") as unknown as Record<string, unknown>),
          dockKind: "scene",
        }}
        onChange={onChange}
        editorUtilityInterface
      />,
    );
    fireEvent.click(screen.getByTestId("ui-dock-kind"));
    const classItem = screen.getByTestId("ui-dock-kind-graph");
    fireEvent.pointerDown(classItem);
    fireEvent.click(classItem);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ dockKind: "graph" }),
    );
  });
});
