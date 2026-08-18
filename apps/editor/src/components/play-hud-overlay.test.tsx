import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createDefaultUserInterface, createWidget } from "@babylonslate/ui-runtime";
import {
  ENGINE_SETTINGS_STORAGE_KEY,
  defaultEngineSettings,
} from "@babylonslate/vfs";
import { parsePlayHudControlId, PlayHudOverlay } from "./play-hud-overlay";

const { attachFullscreenGuiMock } = vi.hoisted(() => ({
  attachFullscreenGuiMock: vi.fn(),
}));

vi.mock("@babylonslate/render", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@babylonslate/render")>();
  return {
    ...actual,
    attachFullscreenGui: (...args: unknown[]) => attachFullscreenGuiMock(...args),
  };
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  attachFullscreenGuiMock.mockReset();
});

function hudWith(
  kind: "TouchButton" | "TouchDPad" | "TouchJoystick" | "Button" | "Image" | "Slider" | "CheckBox" | "TextInput",
  name?: string,
) {
  const doc = createDefaultUserInterface("HUD");
  const widget = createWidget("ctrl", kind, name ?? kind);
  doc.widgets.canvas!.children = ["ctrl"];
  doc.widgets.ctrl = widget;
  return doc;
}

describe("PlayHudOverlay device matching", () => {
  it("uses a custom Engine Settings preset when the viewport matches its size", async () => {
    localStorage.setItem(
      ENGINE_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        ...defaultEngineSettings(),
        uiDesignerPresets: [
          {
            id: "custom-phone",
            label: "Phone",
            width: 390,
            height: 844,
            safeArea: { left: 0, right: 0, top: 47, bottom: 34 },
          },
        ],
      }),
    );
    const { getByTestId } = render(
      <PlayHudOverlay width={390} height={844} onTouchAxis={() => {}} />,
    );
    await waitFor(() => {
      expect(getByTestId("play-hud").getAttribute("data-preset")).toBe(
        "custom-phone",
      );
    });
    expect(getByTestId("play-hud").getAttribute("data-safe-top")).toBe("47");
  });
});

describe("PlayHudOverlay input", () => {
  it("TouchButton pointer down/up feeds the mapped action as a touch axis", () => {
    const onTouchAxis = vi.fn();
    const { getByTestId } = render(
      <PlayHudOverlay
        width={400}
        height={300}
        instances={[{ instanceId: "hud", document: hudWith("TouchButton") }]}
        onTouchAxis={onTouchAxis}
      />,
    );
    const button = getByTestId("play-hud-widget-hud:ctrl");
    fireEvent.pointerDown(button);
    expect(onTouchAxis).toHaveBeenCalledWith("Jump", 1);
    fireEvent.pointerUp(button);
    expect(onTouchAxis).toHaveBeenCalledWith("Jump", 0);
  });

  it("TouchDPad pointer feeds dpad-x / dpad-y", () => {
    const onTouchAxis = vi.fn();
    const { getByTestId } = render(
      <PlayHudOverlay
        width={400}
        height={300}
        instances={[{ instanceId: "hud", document: hudWith("TouchDPad") }]}
        onTouchAxis={onTouchAxis}
      />,
    );
    const pad = getByTestId("play-hud-widget-hud:ctrl");
    fireEvent.pointerDown(pad, { clientX: 300, clientY: 150 });
    expect(onTouchAxis).toHaveBeenCalled();
    const codes = onTouchAxis.mock.calls.map((call) => call[0]);
    expect(codes).toEqual(expect.arrayContaining(["dpad-x", "dpad-y"]));
  });
});

describe("PlayHudOverlay stick chrome", () => {
  it("hides the virtual stick until a TouchJoystick HUD is applied", () => {
    const { queryByTestId } = render(
      <PlayHudOverlay width={400} height={300} onTouchAxis={() => {}} />,
    );
    expect(queryByTestId("play-hud-stick")).toBeNull();
  });

  it("labels an unlabeled TouchJoystick as Stick", () => {
    const { getByTestId } = render(
      <PlayHudOverlay
        width={400}
        height={300}
        instances={[
          { instanceId: "hud", document: hudWith("TouchJoystick") },
        ]}
        onTouchAxis={() => {}}
      />,
    );
    expect(getByTestId("play-hud-stick").textContent).toContain("Stick");
    expect(getByTestId("play-hud-stick").getAttribute("aria-label")).toBe(
      "Stick",
    );
  });

  it("keeps an authored stick name", () => {
    const { getByTestId } = render(
      <PlayHudOverlay
        width={400}
        height={300}
        instances={[
          {
            instanceId: "hud",
            document: hudWith("TouchJoystick", "Move Stick"),
          },
        ]}
        onTouchAxis={() => {}}
      />,
    );
    expect(getByTestId("play-hud-stick").textContent).toContain("Move Stick");
  });
});

describe("parsePlayHudControlId", () => {
  it("keeps nested widget ids after the first instance colon", () => {
    expect(parsePlayHudControlId("ui-1:host/nested-btn")).toEqual({
      instanceId: "ui-1",
      widgetId: "host/nested-btn",
    });
  });
});

describe("PlayHudOverlay widget events", () => {
  it("emits click from a DOM Button without sending a touch axis", () => {
    const onTouchAxis = vi.fn();
    const onWidgetEvent = vi.fn();
    const { getByTestId } = render(
      <PlayHudOverlay
        width={400}
        height={300}
        instances={[{ instanceId: "ui-1", document: hudWith("Button") }]}
        onTouchAxis={onTouchAxis}
        onWidgetEvent={onWidgetEvent}
      />,
    );
    fireEvent.click(getByTestId("play-hud-widget-ui-1:ctrl"));
    expect(onWidgetEvent).toHaveBeenCalledWith({
      instanceId: "ui-1",
      widgetId: "ctrl",
      kind: "click",
    });
    expect(onTouchAxis).not.toHaveBeenCalled();
  });

  it("emits value/checked/text from DOM fallback controls", () => {
    const onWidgetEvent = vi.fn();
    const sliderDoc = hudWith("Slider");
    const checkDoc = hudWith("CheckBox");
    const inputDoc = hudWith("TextInput");
    const { getByTestId, rerender } = render(
      <PlayHudOverlay
        width={400}
        height={300}
        instances={[{ instanceId: "ui-1", document: sliderDoc }]}
        onTouchAxis={() => {}}
        onWidgetEvent={onWidgetEvent}
      />,
    );
    fireEvent.pointerDown(getByTestId("play-hud-widget-ui-1:ctrl"), {
      clientX: 50,
      clientY: 10,
    });
    expect(onWidgetEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: "ui-1",
        widgetId: "ctrl",
        kind: "value",
      }),
    );
    rerender(
      <PlayHudOverlay
        width={400}
        height={300}
        instances={[{ instanceId: "ui-1", document: checkDoc }]}
        onTouchAxis={() => {}}
        onWidgetEvent={onWidgetEvent}
      />,
    );
    fireEvent.click(getByTestId("play-hud-widget-ui-1:ctrl"));
    expect(onWidgetEvent).toHaveBeenCalledWith({
      instanceId: "ui-1",
      widgetId: "ctrl",
      kind: "checked",
      value: true,
    });
    rerender(
      <PlayHudOverlay
        width={400}
        height={300}
        instances={[{ instanceId: "ui-1", document: inputDoc }]}
        onTouchAxis={() => {}}
        onWidgetEvent={onWidgetEvent}
      />,
    );
    const input = getByTestId(
      "play-hud-widget-ui-1:ctrl",
    ) as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    fireEvent.change(input, { target: { value: "hello" } });
    expect(onWidgetEvent).toHaveBeenCalledWith({
      instanceId: "ui-1",
      widgetId: "ctrl",
      kind: "text",
      value: "hello",
    });
  });

  it("forwards Babylon onWidgetEvent with an unprefixed widget id", () => {
    attachFullscreenGuiMock.mockReturnValue({
      adt: { markAsDirty: vi.fn() },
      host: { clear: vi.fn(), addControl: vi.fn(), markAsDirty: vi.fn() },
      dispose: vi.fn(),
    });
    const onWidgetEvent = vi.fn();
    render(
      <PlayHudOverlay
        scene={{} as never}
        width={400}
        height={300}
        instances={[{ instanceId: "ui-1", document: hudWith("Button") }]}
        onTouchAxis={() => {}}
        onWidgetEvent={onWidgetEvent}
      />,
    );
    const options = attachFullscreenGuiMock.mock.calls[0]?.[1] as {
      onWidgetEvent?: (event: { kind: string; widgetId: string }) => void;
    };
    options.onWidgetEvent?.({ kind: "click", widgetId: "ui-1:host/nested-btn" });
    expect(onWidgetEvent).toHaveBeenCalledWith({
      instanceId: "ui-1",
      widgetId: "host/nested-btn",
      kind: "click",
    });
  });

  it("keeps TouchButton pointer down/up on the touch-axis path", () => {
    const onTouchAxis = vi.fn();
    const onWidgetEvent = vi.fn();
    const { getByTestId } = render(
      <PlayHudOverlay
        width={400}
        height={300}
        instances={[{ instanceId: "hud", document: hudWith("TouchButton") }]}
        onTouchAxis={onTouchAxis}
        onWidgetEvent={onWidgetEvent}
      />,
    );
    fireEvent.pointerDown(getByTestId("play-hud-widget-hud:ctrl"));
    expect(onTouchAxis).toHaveBeenCalledWith("Jump", 1);
    expect(onWidgetEvent).not.toHaveBeenCalled();
  });
});

describe("PlayHudOverlay images", () => {
  it("passes resolveImageUrl into the fullscreen GUI host", () => {
    attachFullscreenGuiMock.mockReturnValue({
      adt: { markAsDirty: vi.fn() },
      host: { clear: vi.fn(), addControl: vi.fn(), markAsDirty: vi.fn() },
      dispose: vi.fn(),
    });
    const resolveImageUrl = (guid: string) =>
      guid === "tex-1" ? "blob:tex-1" : null;
    render(
      <PlayHudOverlay
        scene={{} as never}
        width={400}
        height={300}
        instances={[{ instanceId: "hud", document: hudWith("TouchButton") }]}
        onTouchAxis={() => {}}
        resolveImageUrl={resolveImageUrl}
      />,
    );
    expect(attachFullscreenGuiMock).toHaveBeenCalled();
    const options = attachFullscreenGuiMock.mock.calls[0]?.[1] as {
      resolveImageUrl?: (guid: string) => string | null;
    };
    expect(options.resolveImageUrl?.("tex-1")).toBe("blob:tex-1");
    expect(options.resolveImageUrl?.("missing")).toBeNull();
  });

  it("keeps Image and Button widgets in the applied HUD", () => {
    const doc = createDefaultUserInterface("HUD");
    doc.widgets.canvas!.children = ["play-btn", "logo"];
    doc.widgets["play-btn"] = createWidget("play-btn", "Button", "Play");
    doc.widgets.logo = createWidget("logo", "Image", "Logo");
    const { getByTestId } = render(
      <PlayHudOverlay
        width={400}
        height={300}
        instances={[{ instanceId: "ui-1", document: doc }]}
        onTouchAxis={() => {}}
      />,
    );
    expect(getByTestId("play-hud-widget-ui-1:play-btn").getAttribute("data-kind")).toBe(
      "Button",
    );
    expect(getByTestId("play-hud-widget-ui-1:logo").getAttribute("data-kind")).toBe(
      "Image",
    );
  });
});
