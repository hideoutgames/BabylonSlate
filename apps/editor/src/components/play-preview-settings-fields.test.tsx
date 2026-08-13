import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { DEFAULT_PLAY_PREVIEW_PROJECT_SETTINGS } from "@babylonslate/core";
import { PlayPreviewSettingsFields } from "./play-preview-settings-fields";

afterEach(() => {
  cleanup();
});

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

describe("PlayPreviewSettingsFields", () => {
  it("disables aspect fields while Follow System is on", () => {
    const { getByTestId } = render(
      <PlayPreviewSettingsFields
        settings={DEFAULT_PLAY_PREVIEW_PROJECT_SETTINGS}
        onChange={() => {}}
      />,
    );
    expect(
      getByTestId("setting-play-follow-system").getAttribute("aria-checked"),
    ).toBe("true");
    expect(getByTestId("setting-play-aspect-width")).toHaveProperty(
      "disabled",
      true,
    );
    expect(getByTestId("setting-play-aspect-height")).toHaveProperty(
      "disabled",
      true,
    );
    expect(getByTestId("setting-play-aspect-width")).toHaveProperty(
      "value",
      "16",
    );
    expect(getByTestId("setting-play-aspect-height")).toHaveProperty(
      "value",
      "9",
    );
  });

  it("enables aspect fields when Follow System is off", () => {
    const { getByTestId } = render(
      <PlayPreviewSettingsFields
        settings={{
          followSystem: false,
          aspectWidth: 4,
          aspectHeight: 3,
        }}
        onChange={() => {}}
      />,
    );
    expect(
      getByTestId("setting-play-follow-system").getAttribute("aria-checked"),
    ).toBe("false");
    expect(getByTestId("setting-play-aspect-width")).toHaveProperty(
      "disabled",
      false,
    );
    expect(getByTestId("setting-play-aspect-height")).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("emits a full playPreview object when Follow System is toggled", () => {
    const onChange = vi.fn();
    const { getByTestId } = render(
      <PlayPreviewSettingsFields
        settings={{
          followSystem: true,
          aspectWidth: 21,
          aspectHeight: 9,
        }}
        onChange={onChange}
      />,
    );
    fireEvent.click(getByTestId("setting-play-follow-system"));
    expect(onChange).toHaveBeenCalledWith({
      followSystem: false,
      aspectWidth: 21,
      aspectHeight: 9,
    });
  });
});
