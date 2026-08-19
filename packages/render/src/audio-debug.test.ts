import { describe, expect, it } from "vitest";
import {
  audioDebugOverlayText,
  formatAudioDebugOverlay,
  type AudioDebugVoiceSnapshot,
} from "./audio-debug";

describe("formatAudioDebugOverlay", () => {
  it("prints No playing voices when the list is empty", () => {
    expect(formatAudioDebugOverlay([])).toBe("No playing voices");
  });

  it("prints guid, clip, gain, pitch, loop, spatial, radii, and inside radius", () => {
    const voices: AudioDebugVoiceSnapshot[] = [
      {
        assetGuid: "jump",
        clipName: "Jump",
        gain: 0.5,
        pitch: 1.25,
        loop: true,
        spatial: true,
        distance: 10,
        innerRadius: 1,
        maxRadius: 50,
        insideRadius: true,
      },
      {
        assetGuid: "music",
        clipName: null,
        gain: 1,
        pitch: 1,
        loop: false,
        spatial: false,
        distance: null,
        innerRadius: null,
        maxRadius: null,
        insideRadius: null,
      },
    ];
    const text = formatAudioDebugOverlay(voices);
    expect(text).toContain("jump");
    expect(text).toContain("Jump");
    expect(text).toContain("gain 0.50");
    expect(text).toContain("pitch 1.25");
    expect(text).toContain("loop");
    expect(text).toContain("spatial");
    expect(text).toContain("dist 10.00");
    expect(text).toContain("inner 1.00");
    expect(text).toContain("max 50.00");
    expect(text).toContain("inside yes");
    expect(text).toContain("music");
    expect(text).toContain("inside n/a");
  });

  it("returns null when debugVoices is omitted and empty-list copy when on", () => {
    expect(audioDebugOverlayText({})).toBeNull();
    expect(audioDebugOverlayText({ debugVoices: [] })).toBe("No playing voices");
  });
});
