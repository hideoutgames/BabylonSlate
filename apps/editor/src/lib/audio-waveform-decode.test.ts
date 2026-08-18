import { describe, expect, it } from "vitest";
import { decodeAudioWaveformPeaks } from "./audio-waveform-decode";

describe("decodeAudioWaveformPeaks", () => {
  it("returns peaks from an injected decoder and null on failure", async () => {
    const samples = new Float32Array([1, 1, -1, -1]);
    const result = await decodeAudioWaveformPeaks(new Uint8Array([1, 2, 3]), async () => ({
      numberOfChannels: 1,
      duration: 0.5,
      length: samples.length,
      sampleRate: 8,
      getChannelData: () => samples,
    }) as unknown as AudioBuffer);
    expect(result?.durationSeconds).toBe(0.5);
    expect(result?.peaks.length).toBeGreaterThan(0);
    expect(
      await decodeAudioWaveformPeaks(new Uint8Array([1]), async () => {
        throw new Error("bad");
      }),
    ).toBeNull();
  });
});
