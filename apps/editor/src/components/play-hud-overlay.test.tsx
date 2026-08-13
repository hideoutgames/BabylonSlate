import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import {
  ENGINE_SETTINGS_STORAGE_KEY,
  defaultEngineSettings,
} from "@babylonslate/vfs";
import { PlayHudOverlay } from "./play-hud-overlay";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

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
