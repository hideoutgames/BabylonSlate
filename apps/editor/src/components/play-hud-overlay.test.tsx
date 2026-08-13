import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createDefaultUserInterface, createWidget } from "@babylonslate/ui-runtime";
import {
  ENGINE_SETTINGS_STORAGE_KEY,
  defaultEngineSettings,
} from "@babylonslate/vfs";
import { PlayHudOverlay } from "./play-hud-overlay";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function hudWith(kind: "TouchButton" | "TouchDPad") {
  const doc = createDefaultUserInterface("HUD");
  const widget = createWidget("ctrl", kind, kind);
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
