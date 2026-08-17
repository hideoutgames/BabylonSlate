import { describe, expect, it } from "vitest";
import {
  playChromeLaunchAriaLabel,
  playChromeLaunchLabel,
} from "./play-chrome-label";

describe("playChromeLaunchLabel", () => {
  it("reads Play when Preview Build is off", () => {
    expect(playChromeLaunchLabel(false)).toBe("Play");
  });

  it("reads Preview when Preview Build is on", () => {
    expect(playChromeLaunchLabel(true)).toBe("Preview");
  });
});

describe("playChromeLaunchAriaLabel", () => {
  it("keeps the launch name when Play is enabled", () => {
    expect(playChromeLaunchAriaLabel(false, true)).toBe("Play");
    expect(playChromeLaunchAriaLabel(true, true)).toBe("Preview");
  });

  it("explains why launch is disabled", () => {
    expect(playChromeLaunchAriaLabel(false, false)).toBe("Play (Open a Scene)");
    expect(playChromeLaunchAriaLabel(true, false)).toBe(
      "Preview (Set Startup Scene)",
    );
  });
});
