import { describe, expect, it } from "vitest";
import {
  AUDIO_WAVEFORM_BARS,
  extractAudioWaveformPeaks,
  mixAudioChannelsToMonoMaxAbs,
  waveformFromPcmBuffer,
} from "./audio-waveform";

describe("extractAudioWaveformPeaks", () => {
  it("uses 128 bars as the compact preview default", () => {
    expect(AUDIO_WAVEFORM_BARS).toBe(128);
  });

  it("returns zero peaks for silence and empty samples", () => {
    expect(extractAudioWaveformPeaks(new Float32Array(0), 4)).toEqual([
      { min: 0, max: 0 },
      { min: 0, max: 0 },
      { min: 0, max: 0 },
      { min: 0, max: 0 },
    ]);
    expect(extractAudioWaveformPeaks(new Float32Array(8), 2)).toEqual([
      { min: 0, max: 0 },
      { min: 0, max: 0 },
    ]);
    expect(extractAudioWaveformPeaks(new Float32Array([1, -1]), 0)).toEqual([]);
  });

  it("keeps per-bar extrema for a square-ish fixture", () => {
    const samples = new Float32Array(8);
    samples.set([1, 1, 1, 1, -1, -1, -1, -1]);
    expect(extractAudioWaveformPeaks(samples, 2)).toEqual([
      { min: 1, max: 1 },
      { min: -1, max: -1 },
    ]);
  });

  it("mixes channels then peaks a PCM buffer for compact preview", () => {
    const left = new Float32Array([1, 1, -1, -1]);
    const right = new Float32Array([0, 0, 0, 0]);
    const waveform = waveformFromPcmBuffer({
      numberOfChannels: 2,
      duration: 0.25,
      getChannelData: (channel) => (channel === 0 ? left : right),
    }, 2);
    expect(waveform.durationSeconds).toBe(0.25);
    expect(waveform.peaks).toEqual([
      { min: 1, max: 1 },
      { min: -1, max: -1 },
    ]);
  });
});

describe("mixAudioChannelsToMonoMaxAbs", () => {
  it("keeps the larger-magnitude sample and its sign", () => {
    const mixed = mixAudioChannelsToMonoMaxAbs([
      new Float32Array([0.2, -0.1]),
      new Float32Array([-0.8, 0.4]),
    ]);
    expect(mixed[0]).toBeCloseTo(-0.8, 5);
    expect(mixed[1]).toBeCloseTo(0.4, 5);
  });
});
