/** Compact Audio preview draws this many PCM peak bars. */
export const AUDIO_WAVEFORM_BARS = 128;

export type AudioWaveformPeak = {
  min: number;
  max: number;
};

/**
 * Downsample PCM to per-bar extrema for a read-only preview plot.
 * Not waveform editing — samples are display-only.
 */
export function extractAudioWaveformPeaks(
  samples: ArrayLike<number>,
  barCount: number,
): AudioWaveformPeak[] {
  const count = Math.max(0, Math.floor(barCount));
  if (count === 0) return [];
  const length = samples.length;
  if (length === 0) {
    return Array.from({ length: count }, () => ({ min: 0, max: 0 }));
  }
  const peaks: AudioWaveformPeak[] = [];
  for (let i = 0; i < count; i++) {
    const start = Math.floor((i * length) / count);
    const end = Math.max(start + 1, Math.floor(((i + 1) * length) / count));
    let min = samples[start] ?? 0;
    let max = min;
    for (let sampleIndex = start + 1; sampleIndex < end && sampleIndex < length; sampleIndex++) {
      const value = samples[sampleIndex] ?? 0;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    peaks.push({ min, max });
  }
  return peaks;
}

/** Mix interleaved channel buffers to mono using per-frame max-abs. */
export function mixAudioChannelsToMonoMaxAbs(
  channels: readonly ArrayLike<number>[],
): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  const length = channels[0]?.length ?? 0;
  const mono = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let best = 0;
    let sign = 1;
    for (const channel of channels) {
      const value = channel[i] ?? 0;
      const abs = Math.abs(value);
      if (abs >= best) {
        best = abs;
        sign = value < 0 ? -1 : 1;
      }
    }
    mono[i] = sign * best;
  }
  return mono;
}

export type AudioPcmBuffer = {
  numberOfChannels: number;
  duration: number;
  getChannelData(channel: number): Float32Array;
};

export function waveformFromPcmBuffer(
  buffer: AudioPcmBuffer,
  barCount: number = AUDIO_WAVEFORM_BARS,
): { peaks: AudioWaveformPeak[]; durationSeconds: number } {
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < Math.max(0, buffer.numberOfChannels); channel++) {
    channels.push(buffer.getChannelData(channel));
  }
  const samples =
    channels.length === 1
      ? channels[0]!
      : mixAudioChannelsToMonoMaxAbs(channels);
  return {
    peaks: extractAudioWaveformPeaks(samples, barCount),
    durationSeconds: Number.isFinite(buffer.duration) ? Math.max(0, buffer.duration) : 0,
  };
}
