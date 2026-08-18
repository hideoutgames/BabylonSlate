export type AudioDebugVoiceSnapshot = {
  assetGuid: string;
  clipName: string | null;
  gain: number;
  pitch: number;
  loop: boolean;
  spatial: boolean;
  distance: number | null;
  innerRadius: number | null;
  maxRadius: number | null;
  insideRadius: boolean | null;
};

function formatNumber(value: number): string {
  return value.toFixed(2);
}

function formatVoice(voice: AudioDebugVoiceSnapshot): string {
  const parts = [voice.assetGuid];
  if (voice.clipName) parts.push(voice.clipName);
  parts.push(`gain ${formatNumber(voice.gain)}`);
  parts.push(`pitch ${formatNumber(voice.pitch)}`);
  if (voice.loop) parts.push("loop");
  if (voice.spatial) parts.push("spatial");
  if (voice.distance !== null) parts.push(`dist ${formatNumber(voice.distance)}`);
  if (voice.innerRadius !== null) {
    parts.push(`inner ${formatNumber(voice.innerRadius)}`);
  }
  if (voice.maxRadius !== null) parts.push(`max ${formatNumber(voice.maxRadius)}`);
  if (voice.insideRadius === null) parts.push("inside n/a");
  else parts.push(`inside ${voice.insideRadius ? "yes" : "no"}`);
  return parts.join(" ");
}

export function formatAudioDebugOverlay(
  voices: readonly AudioDebugVoiceSnapshot[],
): string {
  if (voices.length === 0) return "No playing voices";
  return voices.map(formatVoice).join("\n");
}

export function audioDebugOverlayText(stats: {
  debugVoices?: readonly AudioDebugVoiceSnapshot[];
}): string | null {
  if (stats.debugVoices === undefined) return null;
  return formatAudioDebugOverlay(stats.debugVoices);
}
