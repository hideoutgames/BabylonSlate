/** A16-oriented audio budgets (engineplan §2.6). */
export const AUDIO_OCCUPANCY_GRID_MAX_X = 24;
export const AUDIO_OCCUPANCY_GRID_MAX_Y = 24;
export const AUDIO_OCCUPANCY_GRID_MAX_Z = 16;
export const AUDIO_VOXEL_SIZE = 2;
export const AUDIO_MAX_PROBES = 32;
export const AUDIO_REVERB_CHUNK_MAX_BYTES = 64 * 1024;
export const AUDIO_BAKE_WORKER_TIMEOUT_MS = 8_000;
export const AUDIO_GEOMETRY_COLLECT_SLICE = 8;
export const AUDIO_BAKE_DEBOUNCE_MS = 1_500;
export const AUDIO_SHARED_REVERB_BUSES = 1;
export const AUDIO_CROSSFADING_PROFILES = 2;
export const AUDIO_PRE_UNLOCK_QUEUE_CAP = 32;
export const AUDIO_DECODED_PCM_LRU_BYTES = 64 * 1024 * 1024;
export const AUDIO_MAX_CONCURRENT_VOICES = 32;

export const AUDIO_ASSET_TYPES = [
  "Audio",
  "AudioMixer",
  "AudioChannel",
  "SoundAttenuation",
] as const;

export type AudioAssetType = (typeof AUDIO_ASSET_TYPES)[number];

export type AudioDiagnostic = {
  code: string;
  message: string;
  guid?: string;
};

export type AudioPayload = {
  volume: number;
  audioChannelGuid: string | null;
  soundAttenuationGuid: string | null;
};

export type AudioChannelEffect = {
  kind: "environmentReverb";
  enabled: boolean;
};

export type AudioChannelPayload = {
  parentChannelGuid: string | null;
  effects: AudioChannelEffect[];
};

export type AudioMixerChannelEntry = {
  channelGuid: string;
  volume: number;
};

export type AudioMixerPayload = {
  globalVolume: number;
  channels: AudioMixerChannelEntry[];
};

export type SoundAttenuationDistanceModel = "linear" | "inverse" | "exponential";
export type SoundAttenuationSpatialisation = "equalPower" | "hrtf";

export type SoundAttenuationCone = {
  innerAngle: number;
  outerAngle: number;
  outerGain: number;
};

export type SoundAttenuationDoppler = {
  enabled: boolean;
  factor: number;
};

export type SoundAttenuationPayload = {
  innerRadius: number;
  maxRadius: number;
  distanceModel: SoundAttenuationDistanceModel;
  rolloff: number;
  spatialisation: SoundAttenuationSpatialisation;
  cone: SoundAttenuationCone | null;
  doppler: SoundAttenuationDoppler | null;
};

export type AudioValidationResult = {
  ok: boolean;
  diagnostics: AudioDiagnostic[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function clampAudioGain(value: unknown, fallback = 1): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function nullableGuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function nonNegative(value: unknown, fallback: number): number {
  const n =
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return n < 0 ? 0 : n;
}

export function createDefaultAudioPayload(): AudioPayload {
  return {
    volume: 1,
    audioChannelGuid: null,
    soundAttenuationGuid: null,
  };
}

export function createDefaultAudioChannelPayload(): AudioChannelPayload {
  return {
    parentChannelGuid: null,
    effects: [{ kind: "environmentReverb", enabled: false }],
  };
}

export function createDefaultAudioMixerPayload(): AudioMixerPayload {
  return { globalVolume: 1, channels: [] };
}

export function createDefaultSoundAttenuationPayload(): SoundAttenuationPayload {
  return {
    innerRadius: 1,
    maxRadius: 50,
    distanceModel: "linear",
    rolloff: 1,
    spatialisation: "equalPower",
    cone: null,
    doppler: null,
  };
}

export function normalizeAudioPayload(value: unknown): AudioPayload {
  const source = asRecord(value);
  return {
    volume: clampAudioGain(source.volume, 1),
    audioChannelGuid: nullableGuid(source.audioChannelGuid),
    soundAttenuationGuid: nullableGuid(source.soundAttenuationGuid),
  };
}

function normalizeChannelEffect(value: unknown): AudioChannelEffect | null {
  const source = asRecord(value);
  if (source.kind !== "environmentReverb") return null;
  return { kind: "environmentReverb", enabled: source.enabled === true };
}

export function normalizeAudioChannelPayload(value: unknown): AudioChannelPayload {
  const source = asRecord(value);
  const effects = Array.isArray(source.effects)
    ? source.effects
        .map(normalizeChannelEffect)
        .filter((entry): entry is AudioChannelEffect => entry !== null)
    : createDefaultAudioChannelPayload().effects;
  return {
    parentChannelGuid: nullableGuid(source.parentChannelGuid),
    effects:
      effects.length > 0
        ? effects
        : [{ kind: "environmentReverb", enabled: false }],
  };
}

export function normalizeAudioMixerPayload(value: unknown): AudioMixerPayload {
  const source = asRecord(value);
  const channels: AudioMixerChannelEntry[] = [];
  if (Array.isArray(source.channels)) {
    for (const entry of source.channels) {
      const row = asRecord(entry);
      const channelGuid = nullableGuid(row.channelGuid);
      if (!channelGuid) continue;
      channels.push({
        channelGuid,
        volume: clampAudioGain(row.volume, 1),
      });
    }
  }
  return {
    globalVolume: clampAudioGain(source.globalVolume, 1),
    channels,
  };
}

function normalizeCone(value: unknown): SoundAttenuationCone | null {
  if (!value || typeof value !== "object") return null;
  const source = asRecord(value);
  const innerAngle = nonNegative(source.innerAngle, 360);
  const outerAngle = Math.max(innerAngle, nonNegative(source.outerAngle, 360));
  return {
    innerAngle,
    outerAngle,
    outerGain: clampAudioGain(source.outerGain, 0),
  };
}

function normalizeDoppler(value: unknown): SoundAttenuationDoppler | null {
  if (!value || typeof value !== "object") return null;
  const source = asRecord(value);
  return {
    enabled: source.enabled === true,
    factor: nonNegative(source.factor, 1),
  };
}

export function normalizeSoundAttenuationPayload(
  value: unknown,
): SoundAttenuationPayload {
  const source = asRecord(value);
  let innerRadius = nonNegative(source.innerRadius, 1);
  let maxRadius = nonNegative(source.maxRadius, 50);
  if (maxRadius < innerRadius) {
    const swap = innerRadius;
    innerRadius = maxRadius;
    maxRadius = swap;
  }
  const distanceModel: SoundAttenuationDistanceModel =
    source.distanceModel === "inverse" || source.distanceModel === "exponential"
      ? source.distanceModel
      : "linear";
  const spatialisation: SoundAttenuationSpatialisation =
    source.spatialisation === "hrtf" ? "hrtf" : "equalPower";
  return {
    innerRadius,
    maxRadius,
    distanceModel,
    rolloff: nonNegative(source.rolloff, 1),
    spatialisation,
    cone: normalizeCone(source.cone),
    doppler: normalizeDoppler(source.doppler),
  };
}

export function resolveAudioReferences(
  payload: AudioPayload,
  knownGuids: ReadonlySet<string>,
): { payload: AudioPayload; diagnostics: AudioDiagnostic[] } {
  const diagnostics: AudioDiagnostic[] = [];
  let audioChannelGuid = payload.audioChannelGuid;
  let soundAttenuationGuid = payload.soundAttenuationGuid;
  if (audioChannelGuid && !knownGuids.has(audioChannelGuid)) {
    diagnostics.push({
      code: "audio.missing_channel",
      message: "Audio Channel is missing; routing falls back to none.",
      guid: audioChannelGuid,
    });
    audioChannelGuid = null;
  }
  if (soundAttenuationGuid && !knownGuids.has(soundAttenuationGuid)) {
    diagnostics.push({
      code: "audio.missing_attenuation",
      message: "Sound Attenuation is missing; playback is non-spatial.",
      guid: soundAttenuationGuid,
    });
    soundAttenuationGuid = null;
  }
  return {
    payload: { ...payload, audioChannelGuid, soundAttenuationGuid },
    diagnostics,
  };
}

export function validateAudioMixer(
  mixer: AudioMixerPayload,
): AudioValidationResult {
  const seen = new Set<string>();
  const diagnostics: AudioDiagnostic[] = [];
  for (const entry of mixer.channels) {
    if (seen.has(entry.channelGuid)) {
      diagnostics.push({
        code: "audio.mixer.duplicate_channel",
        message: "Audio Mixer lists the same Audio Channel more than once.",
        guid: entry.channelGuid,
      });
    }
    seen.add(entry.channelGuid);
  }
  return { ok: diagnostics.length === 0, diagnostics };
}

export function audioChannelHasParentCycle(
  parents: ReadonlyMap<string, string | null>,
  start: string,
): boolean {
  const seen = new Set<string>();
  let current: string | null | undefined = start;
  while (current) {
    if (seen.has(current)) return true;
    seen.add(current);
    current = parents.get(current) ?? null;
  }
  return false;
}

export function validateAudioChannelGraph(
  channels: Record<string, Pick<AudioChannelPayload, "parentChannelGuid">>,
): AudioValidationResult & { resolvedParents: Record<string, string | null> } {
  const parents = new Map<string, string | null>();
  for (const [guid, channel] of Object.entries(channels)) {
    parents.set(guid, channel.parentChannelGuid);
  }
  const diagnostics: AudioDiagnostic[] = [];
  const resolvedParents: Record<string, string | null> = {};
  let cyclic = false;
  for (const guid of Object.keys(channels)) {
    const parent = channels[guid]!.parentChannelGuid;
    if (parent && !parents.has(parent)) {
      diagnostics.push({
        code: "audio.channel.missing_parent",
        message: "Audio Channel parent is missing; routing falls back to master.",
        guid: parent,
      });
      resolvedParents[guid] = null;
    } else {
      resolvedParents[guid] = parent;
    }
    if (audioChannelHasParentCycle(parents, guid)) {
      cyclic = true;
    }
  }
  if (cyclic) {
    diagnostics.push({
      code: "audio.channel.parent_cycle",
      message: "Audio Channel parent chain contains a cycle.",
    });
  }
  return { ok: !cyclic, diagnostics, resolvedParents };
}

function collectGuids(values: Array<string | null | undefined>): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    if (value) unique.add(value);
  }
  return [...unique].sort();
}

export function audioAssetDependencies(
  assetType: string,
  payload: Record<string, unknown>,
): string[] {
  if (assetType === "Audio") {
    const audio = normalizeAudioPayload(payload);
    return collectGuids([audio.audioChannelGuid, audio.soundAttenuationGuid]);
  }
  if (assetType === "AudioMixer") {
    const mixer = normalizeAudioMixerPayload(payload);
    return collectGuids(mixer.channels.map((entry) => entry.channelGuid));
  }
  if (assetType === "AudioChannel") {
    const channel = normalizeAudioChannelPayload(payload);
    return collectGuids([channel.parentChannelGuid]);
  }
  return [];
}

export function computeAudioOutputGain(options: {
  assetVolume: number;
  playCallVolume: number;
  channelGains?: readonly number[];
  globalGain?: number;
}): number {
  let gain =
    clampAudioGain(options.assetVolume) * clampAudioGain(options.playCallVolume);
  for (const channel of options.channelGains ?? []) {
    gain *= clampAudioGain(channel);
  }
  if (options.globalGain !== undefined) {
    gain *= clampAudioGain(options.globalGain);
  }
  return clampAudioGain(gain);
}

export function computeAttenuationGain(
  distance: number,
  attenuation: SoundAttenuationPayload,
): number {
  const d = typeof distance === "number" && Number.isFinite(distance) ? distance : 0;
  const inner = attenuation.innerRadius;
  const max = attenuation.maxRadius;
  if (d <= inner) return 1;
  if (max <= inner || d >= max) return 0;
  const t = (d - inner) / (max - inner);
  const rolloff = attenuation.rolloff > 0 ? attenuation.rolloff : 1;
  if (attenuation.distanceModel === "inverse") {
    const raw = 1 / (1 + rolloff * t);
    const atMax = 1 / (1 + rolloff);
    return clampAudioGain((raw - atMax) / (1 - atMax));
  }
  if (attenuation.distanceModel === "exponential") {
    const raw = Math.exp(-rolloff * t);
    const atMax = Math.exp(-rolloff);
    if (1 - atMax === 0) return clampAudioGain(1 - t);
    return clampAudioGain((raw - atMax) / (1 - atMax));
  }
  return clampAudioGain(1 - t);
}

export function attenuationPlotPoints(
  attenuation: SoundAttenuationPayload,
  samples = 32,
): Array<{ distance: number; gain: number }> {
  const max = Math.max(attenuation.maxRadius, attenuation.innerRadius, 1);
  const count = Math.max(2, samples);
  const points: Array<{ distance: number; gain: number }> = [];
  for (let i = 0; i < count; i += 1) {
    const distance = (i / (count - 1)) * max;
    points.push({
      distance,
      gain: computeAttenuationGain(distance, attenuation),
    });
  }
  return points;
}

export function remapAudioPayloadGuids(
  assetType: string,
  payload: Record<string, unknown>,
  remap: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const rewrite = (guid: string | null): string | null =>
    guid ? (remap.get(guid) ?? guid) : null;
  if (assetType === "Audio") {
    const audio = normalizeAudioPayload(payload);
    return {
      ...audio,
      audioChannelGuid: rewrite(audio.audioChannelGuid),
      soundAttenuationGuid: rewrite(audio.soundAttenuationGuid),
    };
  }
  if (assetType === "AudioMixer") {
    const mixer = normalizeAudioMixerPayload(payload);
    return {
      ...mixer,
      channels: mixer.channels.map((entry) => ({
        ...entry,
        channelGuid: rewrite(entry.channelGuid) ?? entry.channelGuid,
      })),
    };
  }
  if (assetType === "AudioChannel") {
    const channel = normalizeAudioChannelPayload(payload);
    return {
      ...channel,
      parentChannelGuid: rewrite(channel.parentChannelGuid),
    };
  }
  return payload;
}
