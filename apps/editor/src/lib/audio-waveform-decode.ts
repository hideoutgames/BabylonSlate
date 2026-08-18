import { waveformFromPcmBuffer, type AudioWaveformPeak } from "@babylonslate/assets";

export async function decodeAudioWaveformPeaks(
  bytes: Uint8Array,
  decodeAudioData: (data: ArrayBuffer) => Promise<AudioBuffer> = defaultDecodeAudioData,
): Promise<{ peaks: AudioWaveformPeak[]; durationSeconds: number } | null> {
  if (bytes.byteLength === 0) return null;
  try {
    const copy = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
    const buffer = await decodeAudioData(copy);
    return waveformFromPcmBuffer(buffer);
  } catch {
    return null;
  }
}

async function defaultDecodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
  const context = new AudioContext();
  try {
    return await context.decodeAudioData(data);
  } finally {
    void context.close();
  }
}
