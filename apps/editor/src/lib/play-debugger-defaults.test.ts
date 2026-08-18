import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAY_DEBUGGER_OVERLAY,
  playDebuggerOverlayFromSettings,
} from "./play-debugger-defaults";

describe("playDebuggerOverlayFromSettings", () => {
  it("turns Stats, Console, and Inspector on and Pause On Play off by default", () => {
    expect(playDebuggerOverlayFromSettings()).toEqual(
      DEFAULT_PLAY_DEBUGGER_OVERLAY,
    );
    expect(playDebuggerOverlayFromSettings({})).toEqual(
      DEFAULT_PLAY_DEBUGGER_OVERLAY,
    );
    expect(playDebuggerOverlayFromSettings(null)).toEqual(
      DEFAULT_PLAY_DEBUGGER_OVERLAY,
    );
  });

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
