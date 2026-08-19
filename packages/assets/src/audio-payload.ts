import { concatBytes, readU32LE, writeU32LE } from "./bytes";

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
export const AUDIO_REVERB_COMB_COUNT = 4;
export const AUDIO_REVERB_ALLPASS_COUNT = 2;
export const AUDIO_CROSSFADING_PROFILES = 2;
export const AUDIO_SPEED_OF_SOUND = 343;
export const AUDIO_PRE_UNLOCK_QUEUE_CAP = 32;
export const AUDIO_DECODED_PCM_LRU_BYTES = 64 * 1024 * 1024;
export const AUDIO_MAX_CONCURRENT_VOICES = 32;
export const AUDIO_MAX_CLIPS = 8;
export const AUDIO_PITCH_MIN = 0.25;
export const AUDIO_PITCH_MAX = 4;
export const AUDIO_DEFAULT_SOURCE_CHUNK = "source";

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

export type AudioClipPayload = {
  chunkId: string;
  name: string;
  weight: number;
};

export type AudioPayload = {
  volume: number;
  audioChannelGuid: string | null;
  soundAttenuationGuid: string | null;
  clips: AudioClipPayload[];
  pitch: number;
  pitchRandom: boolean;
  pitchMin: number;
  pitchMax: number;
  loop: boolean;
};

export type AudioChannelEffect =
  | { kind: "environmentReverb"; enabled: boolean }
  | { kind: "muffleThroughWalls"; enabled: boolean };

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

function clampPitch(value: unknown, fallback = 1): number {
  const n =
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  if (n < AUDIO_PITCH_MIN) return AUDIO_PITCH_MIN;
  if (n > AUDIO_PITCH_MAX) return AUDIO_PITCH_MAX;
  return n;
}

function defaultAudioClip(): AudioClipPayload {
  return { chunkId: AUDIO_DEFAULT_SOURCE_CHUNK, name: "", weight: 1 };
}

function normalizeAudioClip(value: unknown): AudioClipPayload | null {
  const source = asRecord(value);
  const chunkId =
    typeof source.chunkId === "string" ? source.chunkId.trim() : "";
  if (!chunkId) return null;
  const name = typeof source.name === "string" ? source.name : "";
  const weightRaw =
    typeof source.weight === "number" && Number.isFinite(source.weight)
      ? source.weight
      : 1;
  return {
    chunkId,
    name,
    weight: weightRaw < 0 ? 0 : weightRaw,
  };
}

function normalizeAudioClips(value: unknown): AudioClipPayload[] {
  const raw = Array.isArray(value)
    ? value
        .map(normalizeAudioClip)
        .filter((clip): clip is AudioClipPayload => clip !== null)
        .slice(0, AUDIO_MAX_CLIPS)
    : [];
  const clips = raw.length > 0 ? raw : [defaultAudioClip()];
  const total = clips.reduce((sum, clip) => sum + clip.weight, 0);
  if (total > 0) return clips;
  return clips.map((clip) => ({ ...clip, weight: 1 }));
}

export function createDefaultAudioPayload(): AudioPayload {
  return {
    volume: 1,
    audioChannelGuid: null,
    soundAttenuationGuid: null,
    clips: [defaultAudioClip()],
    pitch: 1,
    pitchRandom: false,
    pitchMin: 1,
    pitchMax: 1,
    loop: false,
  };
}

export function createDefaultAudioChannelPayload(): AudioChannelPayload {
  return {
    parentChannelGuid: null,
    effects: [
      { kind: "environmentReverb", enabled: false },
      { kind: "muffleThroughWalls", enabled: false },
    ],
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

export function fillEmptySourceClipName(
  payload: AudioPayload | unknown,
  assetName: string,
): AudioPayload {
  const audio = normalizeAudioPayload(payload);
  const name = assetName.trim();
  if (!name) return audio;
  let changed = false;
  const clips = audio.clips.map((clip) => {
    if (clip.chunkId !== AUDIO_DEFAULT_SOURCE_CHUNK) return clip;
    if (clip.name.trim() !== "") return clip;
    changed = true;
    return { ...clip, name };
  });
  return changed ? { ...audio, clips } : audio;
}

export function normalizeAudioPayload(value: unknown): AudioPayload {
  const source = asRecord(value);
  let pitchMin = clampPitch(source.pitchMin, 1);
  let pitchMax = clampPitch(source.pitchMax, 1);
  if (pitchMax < pitchMin) {
    const swap = pitchMin;
    pitchMin = pitchMax;
    pitchMax = swap;
  }
  return {
    volume: clampAudioGain(source.volume, 1),
    audioChannelGuid: nullableGuid(source.audioChannelGuid),
    soundAttenuationGuid: nullableGuid(source.soundAttenuationGuid),
    clips: normalizeAudioClips(source.clips),
    pitch: clampPitch(source.pitch, 1),
    pitchRandom: source.pitchRandom === true,
    pitchMin,
    pitchMax,
    loop: source.loop === true,
  };
}

export function pickWeightedAudioClip(
  clips: readonly AudioClipPayload[],
  random: () => number = Math.random,
): AudioClipPayload {
  const list = clips.length > 0 ? clips : [defaultAudioClip()];
  const total = list.reduce((sum, clip) => sum + Math.max(0, clip.weight), 0);
  if (total <= 0) return list[0]!;
  const sample = Math.min(0.999999, Math.max(0, random())) * total;
  let cursor = 0;
  for (const clip of list) {
    cursor += Math.max(0, clip.weight);
    if (sample < cursor) return clip;
  }
  return list[list.length - 1]!;
}

export function resolveAudioPitch(
  payload: Pick<AudioPayload, "pitch" | "pitchRandom" | "pitchMin" | "pitchMax">,
  random: () => number = Math.random,
): number {
  if (!payload.pitchRandom) return clampPitch(payload.pitch, 1);
  const min = clampPitch(payload.pitchMin, 1);
  const max = clampPitch(payload.pitchMax, 1);
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const t = Math.min(1, Math.max(0, random()));
  return lo + (hi - lo) * t;
}

export function audioClipCacheKey(assetGuid: string, chunkId: string): string {
  return `${assetGuid}:${chunkId}`;
}

export async function collectAudioClipSourceBytes(options: {
  assetGuid: string;
  payload: unknown;
  readChunk: (chunkId: string) => Promise<Uint8Array | null | undefined>;
}): Promise<Map<string, Uint8Array>> {
  const audio = normalizeAudioPayload(options.payload);
  const out = new Map<string, Uint8Array>();
  for (const clip of audio.clips) {
    const bytes = await options.readChunk(clip.chunkId);
    if (!bytes || bytes.byteLength === 0) continue;
    out.set(audioClipCacheKey(options.assetGuid, clip.chunkId), bytes);
    if (clip.chunkId === AUDIO_DEFAULT_SOURCE_CHUNK) {
      out.set(options.assetGuid, bytes);
    }
  }
  return out;
}

export function mapPackedAudioClipBytes(
  assetGuid: string,
  packed: { payload: AudioPayload; source: Uint8Array; sources: Uint8Array[] },
): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const sources =
    packed.sources.length > 0 ? packed.sources : [packed.source];
  const first = sources[0] ?? packed.source;
  if (first.byteLength > 0) out.set(assetGuid, first);
  packed.payload.clips.forEach((clip, index) => {
    const bytes = sources[index];
    if (!bytes || bytes.byteLength === 0) return;
    out.set(audioClipCacheKey(assetGuid, clip.chunkId), bytes);
  });
  return out;
}

export async function collectPackedAudioClipBlobs(options: {
  payload: unknown;
  readChunk: (chunkId: string) => Promise<Uint8Array | null | undefined>;
}): Promise<Uint8Array[] | null> {
  const audio = normalizeAudioPayload(options.payload);
  const blobs: Uint8Array[] = [];
  for (const clip of audio.clips) {
    const bytes = await options.readChunk(clip.chunkId);
    blobs.push(bytes && bytes.byteLength > 0 ? bytes : new Uint8Array());
  }
  if (blobs.every((blob) => blob.byteLength === 0)) return null;
  return blobs;
}

export function allocateAudioClipChunkId(
  existingChunkIds: readonly string[],
): string | null {
  const used = new Set(existingChunkIds);
  if (!used.has(AUDIO_DEFAULT_SOURCE_CHUNK)) return AUDIO_DEFAULT_SOURCE_CHUNK;
  const clipCount = [...used].filter(
    (id) =>
      id === AUDIO_DEFAULT_SOURCE_CHUNK ||
      id.startsWith(`${AUDIO_DEFAULT_SOURCE_CHUNK}:`),
  ).length;
  if (clipCount >= AUDIO_MAX_CLIPS) return null;
  for (let n = 2; n <= AUDIO_MAX_CLIPS + 8; n += 1) {
    const id = `${AUDIO_DEFAULT_SOURCE_CHUNK}:${n}`;
    if (!used.has(id)) return id;
  }
  return null;
}

type AudioExtraChunkLike = {
  id: string;
  kind?: string;
  mime?: string;
  data?: Uint8Array;
};

function keepAudioExtraChunks(
  extra: Iterable<AudioExtraChunkLike>,
  skipId?: string,
): Array<{ id: string; kind: string; mime: string; data: Uint8Array }> {
  const next: Array<{ id: string; kind: string; mime: string; data: Uint8Array }> =
    [];
  for (const chunk of extra) {
    if (!chunk.data || chunk.id === skipId) continue;
    next.push({
      id: chunk.id,
      kind: chunk.kind ?? "audio",
      mime: chunk.mime ?? "application/octet-stream",
      data: chunk.data,
    });
  }
  return next;
}

export function extraChunksWithAudioClip(
  extra: Iterable<AudioExtraChunkLike>,
  clip: { id: string; bytes: Uint8Array; mime: string },
): Array<{ id: string; kind: string; mime: string; data: Uint8Array }> {
  const next = keepAudioExtraChunks(extra, clip.id);
  next.push({
    id: clip.id,
    kind: "audio",
    mime: clip.mime,
    data: clip.bytes,
  });
  return next;
}

export function extraChunksWithoutAudioClip(
  extra: Iterable<AudioExtraChunkLike>,
  chunkId: string,
): Array<{ id: string; kind: string; mime: string; data: Uint8Array }> {
  if (chunkId === AUDIO_DEFAULT_SOURCE_CHUNK) {
    return keepAudioExtraChunks(extra);
  }
  return keepAudioExtraChunks(extra, chunkId);
}

function normalizeChannelEffect(value: unknown): AudioChannelEffect | null {
  const source = asRecord(value);
  if (source.kind === "environmentReverb" || source.kind === "muffleThroughWalls") {
    return { kind: source.kind, enabled: source.enabled === true };
  }
  return null;
}

const DEFAULT_CHANNEL_EFFECTS: AudioChannelEffect[] = [
  { kind: "environmentReverb", enabled: false },
  { kind: "muffleThroughWalls", enabled: false },
];

function ensureChannelEffects(effects: AudioChannelEffect[]): AudioChannelEffect[] {
  const seen = new Set<AudioChannelEffect["kind"]>();
  const next: AudioChannelEffect[] = [];
  for (const effect of effects) {
    if (seen.has(effect.kind)) continue;
    seen.add(effect.kind);
    next.push(effect);
  }
  for (const fallback of DEFAULT_CHANNEL_EFFECTS) {
    if (!seen.has(fallback.kind)) next.push(fallback);
  }
  return next;
}

export function setAudioChannelEffect(
  payload: AudioChannelPayload,
  kind: AudioChannelEffect["kind"],
  enabled: boolean,
): AudioChannelPayload {
  const effects = ensureChannelEffects(payload.effects).map((effect) =>
    effect.kind === kind ? { kind, enabled } : effect,
  );
  return { ...payload, effects };
}

export function normalizeAudioChannelPayload(value: unknown): AudioChannelPayload {
  const source = asRecord(value);
  const effects = Array.isArray(source.effects)
    ? source.effects
        .map(normalizeChannelEffect)
        .filter((entry): entry is AudioChannelEffect => entry !== null)
    : DEFAULT_CHANNEL_EFFECTS;
  return {
    parentChannelGuid: nullableGuid(source.parentChannelGuid),
    effects: ensureChannelEffects(
      effects.length > 0 ? effects : DEFAULT_CHANNEL_EFFECTS,
    ),
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
  payload: AudioPayload | unknown,
  knownGuids: ReadonlySet<string>,
): { payload: AudioPayload; diagnostics: AudioDiagnostic[] } {
  const audio = normalizeAudioPayload(payload);
  const diagnostics: AudioDiagnostic[] = [];
  let audioChannelGuid = audio.audioChannelGuid;
  let soundAttenuationGuid = audio.soundAttenuationGuid;
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
    payload: { ...audio, audioChannelGuid, soundAttenuationGuid },
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
    } else if (audioChannelHasParentCycle(parents, guid)) {
      cyclic = true;
      resolvedParents[guid] = null;
    } else {
      resolvedParents[guid] = parent;
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

export function sanitizeAudioLibrary(input: {
  audio: ReadonlyMap<string, AudioPayload | unknown>;
  channels: ReadonlyMap<string, AudioChannelPayload>;
  attenuations: ReadonlyMap<string, SoundAttenuationPayload>;
}): {
  audio: Map<string, AudioPayload>;
  channels: Map<string, AudioChannelPayload>;
  diagnostics: AudioDiagnostic[];
} {
  const diagnostics: AudioDiagnostic[] = [];
  const known = new Set([
    ...input.channels.keys(),
    ...input.attenuations.keys(),
  ]);
  const audio = new Map<string, AudioPayload>();
  for (const [guid, payload] of input.audio) {
    const resolved = resolveAudioReferences(payload, known);
    diagnostics.push(...resolved.diagnostics);
    audio.set(guid, resolved.payload);
  }
  const graph = validateAudioChannelGraph(
    Object.fromEntries(
      [...input.channels].map(([guid, channel]) => [
        guid,
        { parentChannelGuid: channel.parentChannelGuid },
      ]),
    ),
  );
  diagnostics.push(...graph.diagnostics);
  const channels = new Map<string, AudioChannelPayload>();
  for (const [guid, channel] of input.channels) {
    channels.set(guid, {
      ...channel,
      parentChannelGuid: graph.resolvedParents[guid] ?? null,
    });
  }
  return { audio, channels, diagnostics };
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

export type AudioPlaybackResolution = {
  gain: number;
  channelGuids: string[];
  environmentReverb: boolean;
  muffleThroughWalls: boolean;
};

export function resolveAudioPlayback(options: {
  audio: AudioPayload | unknown;
  playCallVolume: number;
  mixer: AudioMixerPayload | null;
  channels: ReadonlyMap<string, AudioChannelPayload>;
  sessionChannelVolumes?: ReadonlyMap<string, number>;
  sessionGlobalVolume?: number | null;
}): AudioPlaybackResolution {
  const audio = normalizeAudioPayload(options.audio);
  const channelGuids: string[] = [];
  let environmentReverb = false;
  let muffleThroughWalls = false;
  const start = audio.audioChannelGuid;
  if (start) {
    const seen = new Set<string>();
    let current: string | null = start;
    while (current && !seen.has(current)) {
      seen.add(current);
      channelGuids.push(current);
      const channel = options.channels.get(current);
      if (
        channel?.effects.some(
          (effect) => effect.kind === "environmentReverb" && effect.enabled,
        )
      ) {
        environmentReverb = true;
      }
      if (
        channel?.effects.some(
          (effect) => effect.kind === "muffleThroughWalls" && effect.enabled,
        )
      ) {
        muffleThroughWalls = true;
      }
      current = channel?.parentChannelGuid ?? null;
    }
  }
  const mixer = options.mixer;
  const channelGains: number[] = [];
  if (mixer) {
    const byGuid = new Map(
      mixer.channels.map((entry) => [entry.channelGuid, entry.volume] as const),
    );
    for (const guid of channelGuids) {
      const session = options.sessionChannelVolumes?.get(guid);
      const fallback = byGuid.get(guid);
      if (session !== undefined) channelGains.push(clampAudioGain(session));
      else if (fallback !== undefined) channelGains.push(clampAudioGain(fallback));
    }
  }
  const globalGain =
    mixer === null
      ? undefined
      : options.sessionGlobalVolume !== undefined &&
          options.sessionGlobalVolume !== null
        ? options.sessionGlobalVolume
        : mixer.globalVolume;
  return {
    gain: computeAudioOutputGain({
      assetVolume: audio.volume,
      playCallVolume: options.playCallVolume,
      channelGains: mixer ? channelGains : undefined,
      globalGain,
    }),
    channelGuids,
    environmentReverb,
    muffleThroughWalls,
  };
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

/** Web Audio no longer has PannerNode Doppler; playbackRate carries the authored factor. */
export function computeDopplerPlaybackRate(options: {
  emitter: { x: number; y: number; z: number };
  previousEmitter: { x: number; y: number; z: number } | null;
  listener: { x: number; y: number; z: number };
  dt: number;
  factor: number;
}): number {
  if (!options.previousEmitter || !(options.dt > 0) || !(options.factor > 0)) {
    return 1;
  }
  const vx = (options.emitter.x - options.previousEmitter.x) / options.dt;
  const vy = (options.emitter.y - options.previousEmitter.y) / options.dt;
  const vz = (options.emitter.z - options.previousEmitter.z) / options.dt;
  const dx = options.listener.x - options.emitter.x;
  const dy = options.listener.y - options.emitter.y;
  const dz = options.listener.z - options.emitter.z;
  const distance = Math.hypot(dx, dy, dz);
  if (distance < 1e-4) return 1;
  const radialTowardListener = (vx * dx + vy * dy + vz * dz) / distance;
  const rate = 1 + options.factor * (radialTowardListener / AUDIO_SPEED_OF_SOUND);
  if (rate < 0.25) return 0.25;
  if (rate > 4) return 4;
  return rate;
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

const PACKED_AUDIO_MAGIC = new Uint8Array([0x42, 0x53, 0x41, 0x55]); // BSAU
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Pack Audio JSON payload with source bytes so export can ship both. */
export function encodePackedAudioAsset(
  payload: AudioPayload | Record<string, unknown>,
  source: Uint8Array | readonly Uint8Array[],
): Uint8Array {
  const json = encoder.encode(JSON.stringify(normalizeAudioPayload(payload)));
  const blobs = Array.isArray(source) ? source : [source];
  if (blobs.length <= 1) {
    return concatBytes([
      PACKED_AUDIO_MAGIC,
      writeU32LE(json.byteLength),
      json,
      blobs[0] ?? new Uint8Array(),
    ]);
  }
  const parts: Uint8Array[] = [
    PACKED_AUDIO_MAGIC,
    writeU32LE(json.byteLength),
    json,
    writeU32LE(blobs.length),
  ];
  for (const blob of blobs) {
    parts.push(writeU32LE(blob.byteLength), blob);
  }
  return concatBytes(parts);
}

function decodePackedClipTable(rest: Uint8Array): Uint8Array[] | null {
  if (rest.byteLength < 4) return null;
  const count = readU32LE(rest, 0);
  if (count < 2 || count > AUDIO_MAX_CLIPS) return null;
  let offset = 4;
  const clips: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 4 > rest.byteLength) return null;
    const len = readU32LE(rest, offset);
    offset += 4;
    if (len < 0 || offset + len > rest.byteLength) return null;
    clips.push(rest.subarray(offset, offset + len));
    offset += len;
  }
  if (offset !== rest.byteLength) return null;
  return clips;
}

/** Unwrap a packed Audio envelope; raw WAV/MP3/OGG returns null. */
export function decodePackedAudioAsset(
  bytes: Uint8Array,
): { payload: AudioPayload; source: Uint8Array; sources: Uint8Array[] } | null {
  if (bytes.byteLength < 8) return null;
  for (let i = 0; i < PACKED_AUDIO_MAGIC.length; i++) {
    if (bytes[i] !== PACKED_AUDIO_MAGIC[i]) return null;
  }
  const jsonLen = readU32LE(bytes, 4);
  const jsonStart = 8;
  const jsonEnd = jsonStart + jsonLen;
  if (jsonLen < 0 || jsonEnd > bytes.byteLength) return null;
  try {
    const parsed = JSON.parse(decoder.decode(bytes.subarray(jsonStart, jsonEnd)));
    const rest = bytes.subarray(jsonEnd);
    const table = decodePackedClipTable(rest);
    const sources = table ?? [rest];
    const source = sources[0] ?? new Uint8Array();
    return {
      payload: normalizeAudioPayload(parsed),
      source,
      sources,
    };
  } catch {
    return null;
  }
}
