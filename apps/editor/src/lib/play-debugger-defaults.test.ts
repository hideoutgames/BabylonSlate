import { describe, expect, it } from "vitest";
import {
  nextPlayInspectorOpen,
  playDebuggerOverlayFromSettings,
} from "./play-debugger-defaults";

describe("playDebuggerOverlayFromSettings", () => {
  it("keeps overlay chrome on when saved defaults omit the new fields", () => {
    expect(
      playDebuggerOverlayFromSettings({ pauseOnPlay: true }),
    ).toEqual({
      overlayStats: true,
      overlayConsole: true,
      overlayInspector: true,
      pauseOnPlay: true,
    });
  });

  it("honors explicit overlay chrome off", () => {
    expect(
      playDebuggerOverlayFromSettings({
        overlayStats: false,
        overlayConsole: false,
        overlayInspector: false,
        pauseOnPlay: false,
      }),
    ).toEqual({
      overlayStats: false,
      overlayConsole: false,
      overlayInspector: false,
      pauseOnPlay: false,
    });
  });
});

describe("nextPlayInspectorOpen", () => {
  it("closes the inspector dialog when Debug Overlay Inspector is unchecked", () => {
    expect(nextPlayInspectorOpen(true, false)).toBe(false);
    expect(nextPlayInspectorOpen(false, false)).toBe(false);
  });

  it("keeps the dialog closed until the overlay Inspector toggle opens it", () => {
    expect(nextPlayInspectorOpen(false, true)).toBe(false);
    expect(nextPlayInspectorOpen(true, true)).toBe(true);
  });
});
