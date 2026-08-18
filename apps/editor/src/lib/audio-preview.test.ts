import { describe, expect, it } from "vitest";
import { stopAudioPreviewElement } from "./audio-preview";

describe("stopAudioPreviewElement", () => {
  it("pauses and resets the element so Stop is not a silent toggle", () => {
    const element = {
      pause: () => {
        element.paused = true;
      },
      paused: false,
      currentTime: 1.25,
    };
    stopAudioPreviewElement(element);
    expect(element.paused).toBe(true);
    expect(element.currentTime).toBe(0);
  });
});
