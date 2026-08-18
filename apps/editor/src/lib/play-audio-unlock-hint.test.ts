import { describe, expect, it } from "vitest";
import {
  PLAY_AUDIO_UNLOCK_HINT,
  shouldShowPlayAudioUnlockHint,
} from "./play-audio-unlock-hint";

describe("play audio unlock hint", () => {
  it("shows when play-on-start is queued and the view is still locked", () => {
    expect(
      shouldShowPlayAudioUnlockHint({ queued: 1, unlocked: false }),
    ).toBe(true);
    expect(PLAY_AUDIO_UNLOCK_HINT).toBe("Click the game view to enable audio");
  });

  it("hides after the first gesture or when nothing is waiting", () => {
    expect(
      shouldShowPlayAudioUnlockHint({ queued: 1, unlocked: true }),
    ).toBe(false);
    expect(
      shouldShowPlayAudioUnlockHint({ queued: 0, unlocked: false }),
    ).toBe(false);
  });
});
