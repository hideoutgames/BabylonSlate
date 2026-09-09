import { describe, expect, it } from "vitest";
import { createPlayerPauseState } from "./console-pause";

describe("Player console and lifecycle pause", () => {
  it("preserves a user's pause across background and foreground transitions", () => {
    const pause = createPlayerPauseState();
    expect(pause.setConsolePaused(true)).toBe(true);
    expect(pause.setLifecyclePaused(true)).toBe(true);
    expect(pause.setLifecyclePaused(false)).toBe(true);
    expect(pause.setConsolePaused(false)).toBe(false);
  });

  it("defers a console resume until the player returns to the foreground", () => {
    const pause = createPlayerPauseState();
    expect(pause.setLifecyclePaused(true)).toBe(true);
    expect(pause.setConsolePaused(false)).toBe(true);
    expect(pause.setLifecyclePaused(false)).toBe(false);
  });
});
