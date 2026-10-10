import {
  createDefaultAudioChannelPayload,
  createDefaultAudioMixerPayload,
  createDefaultSoundAttenuationPayload,
  normalizeAudioMixerPayload,
  normalizeAudioPayload,
  setAudioChannelEffect,
  validateAudioMixer,
  type AudioChannelPayload,
  type AudioMixerPayload,
  type AudioPayload,
  type SoundAttenuationPayload,
} from "@babylonslate/assets";
import { lookAtRotation, type SerializedActor } from "@babylonslate/core";
import { actor, comp, meshComp, tf, type FeatureTestContext, type Vec3 } from "./context";
import { FEATURE_TEST_OPTIONAL_SLOTS } from "./engine-content-files";

/**
 * Audio area: a three-level Audio Channel hierarchy, two Sound Attenuations,
 * the project Audio Mixer, the optional CC0 loop / one-shot Audio assets and
 * Audio Component emitters. No audio is generated: an empty slot leaves its
 * Audio ref null and the matching emitters silent.
 */

/** Folder under `assets/FeatureTest/` for every audio asset. */
export const FEATURE_TEST_AUDIO_FOLDER = "Audio";

/** Asset names, so tests and docs can find them by path. */
export const FEATURE_TEST_AUDIO_NAMES = {
  /** Root channel (no effects). */
  masterChannel: "FT_AudioMaster",
  /** Child of Master with environment reverb and wall muffling. */
  worldChannel: "FT_AudioWorld",
  /** Child of World; inherits its effects. */
  cueChannel: "FT_AudioCues",
  /** Inverse falloff, 2–20 m, directional cone and Doppler. */
  nearAttenuation: "FT_AudioNear",
  /** Linear falloff, 20–150 m, HRTF panning. */
  wideAttenuation: "FT_AudioWide",
  /** Selected in Project Settings → Audio. */
  mixer: "FT_AudioMixer",
  /** Optional slot `FT_Loop.*` imported as a looping, spatial World sound. */
  loop: "FT_AudioLoop",
  /** Optional slot `FT_OneShot.*` imported as a Cues sound. */
  oneShot: "FT_AudioOneShot",
} as const;

const NAMES = FEATURE_TEST_AUDIO_NAMES;
const FOLDER = FEATURE_TEST_AUDIO_FOLDER;

/** Mixer table: per-channel default gains (the gain chain multiplies them). */
const MIXER_GLOBAL_VOLUME = 0.8;
const CHANNEL_VOLUMES = { master: 1, world: 0.9, cues: 0.75 } as const;

/**
 * Create channels (parent first), attenuations, the optional Audio imports and
 * the mixer, fill `ctx.assets.audio`, and select the mixer in Project Settings.
 */
export async function buildFeatureTestAudio(ctx: FeatureTestContext): Promise<void> {
  const master = await createChannel(ctx, NAMES.masterChannel, createDefaultAudioChannelPayload());
  const world = await createChannel(
    ctx,
    NAMES.worldChannel,
    setAudioChannelEffect(
      setAudioChannelEffect({ ...createDefaultAudioChannelPayload(), parentChannelGuid: master }, "environmentReverb", true),
      "muffleThroughWalls",
      true,
    ),
  );
  const cues = await createChannel(ctx, NAMES.cueChannel, {
    ...createDefaultAudioChannelPayload(),
    parentChannelGuid: world,
  });

  const near = await createAttenuation(ctx, NAMES.nearAttenuation, {
    ...createDefaultSoundAttenuationPayload(),
    innerRadius: 2,
    maxRadius: 20,
    distanceModel: "inverse",
    rolloff: 1,
    spatialisation: "equalPower",
    cone: { innerAngle: 120, outerAngle: 260, outerGain: 0.3 },
    doppler: { enabled: true, factor: 1 },
  });
  const wide = await createAttenuation(ctx, NAMES.wideAttenuation, {
    ...createDefaultSoundAttenuationPayload(),
    innerRadius: 20,
    maxRadius: 150,
    distanceModel: "linear",
    rolloff: 1,
    spatialisation: "hrtf",
  });

  // Deterministic playback: one clip per asset and no random pitch.
  const loop = await importOptionalAudio(ctx, FEATURE_TEST_OPTIONAL_SLOTS.loopAudio, NAMES.loop, {
    loop: true,
    volume: 0.7,
    audioChannelGuid: world,
    soundAttenuationGuid: near,
  });
  const oneShot = await importOptionalAudio(ctx, FEATURE_TEST_OPTIONAL_SLOTS.oneShotAudio, NAMES.oneShot, {
    loop: false,
    volume: 0.8,
    audioChannelGuid: cues,
    soundAttenuationGuid: wide,
  });

  const mixerPayload: AudioMixerPayload = {
    ...createDefaultAudioMixerPayload(),
    globalVolume: MIXER_GLOBAL_VOLUME,
    channels: [
      { channelGuid: master, volume: CHANNEL_VOLUMES.master },
      { channelGuid: world, volume: CHANNEL_VOLUMES.world },
      { channelGuid: cues, volume: CHANNEL_VOLUMES.cues },
    ],
  };
  const mixerCheck = validateAudioMixer(normalizeAudioMixerPayload(mixerPayload));
  if (!mixerCheck.ok) throw new Error(mixerCheck.diagnostics.map((entry) => entry.message).join("; "));
  const mixer = (await ctx.createAsset("AudioMixer", FOLDER, NAMES.mixer, { payload: record(mixerPayload) })).guid;

  Object.assign(ctx.assets.audio, { loop, oneShot, mixer, channel: world, attenuation: near });
  ctx.patchSettings((settings) => ({
    ...settings,
    audio: { ...settings.audio, audioMixerGuid: mixer, occlusionEnabled: true },
  }));
}

/**
 * `Audio` zone: floor, three Audio Component emitters (spatial loop, one-shot
 * cue, cue forced to loop by the component), a static muffle wall and back
 * wall, captions, and a listener camera (`possess "Audio Listener Camera"`).
 * Emitters always exist; their Audio is null when the CC0 slot is empty.
 */
export async function placeFeatureTestAudio(ctx: FeatureTestContext): Promise<void> {
  const zone = ctx.zone("audio");
  const add = (next: SerializedActor) => ctx.addActor(next, { zone: "audio" });
  zone.floor();
  const { loop, oneShot } = ctx.assets.audio;
  const surface = ctx.assets.materials.surface ?? null;
  const emissive = ctx.assets.materials.emissive ?? null;
  const font = ctx.assets.fonts.facetype || null;

  add(emitter("ft-audio-loop", "Spatial Loop Emitter", zone.at(-5, 1, 2), "cylinder", emissive, {
    audioAssetGuid: loop,
    loop: true,
    volume: 1,
  }));
  add(emitter("ft-audio-one-shot", "One Shot Cue Emitter", zone.at(2, 1, 2), "sphere", surface, {
    audioAssetGuid: oneShot,
    loop: false,
    volume: 0.8,
  }));
  add(emitter("ft-audio-cue-loop", "Looping Cue Emitter", zone.at(7, 1, 2), "sphere", emissive, {
    audioAssetGuid: oneShot,
    loop: true,
    volume: 0.5,
  }));

  // Static meshes: the wall sits between the loop emitter and the listener (muffling)
  // and both feed the scene's reverb bake.
  add(wall("ft-audio-muffle-wall", "Muffle Wall", zone.at(-5, 1.2, -2), [4, 2.4, 0.3], surface));
  add(wall("ft-audio-back-wall", "Reverb Back Wall", zone.at(1, 2, 8), [20, 4, 0.3], surface));

  const listener = zone.at(0, 4, -11);
  const listenerView = tf(listener, { rotation: lookAtRotation(listener, zone.at(0, 1, 2)) });
  add(actor("ft-audio-listener", "Audio Listener Camera", listenerView, [
    comp("ft-audio-listener-cam", "CameraComponent", { fieldOfView: 60, farClip: 120 }),
  ]));

  const slotLabel = (guid: string | null, label: string) => (guid ? label : `${label} (Empty Slot)`);
  add(caption("ft-audio-caption-loop", "Loop Caption", zone.at(-5, 0.3, -5), slotLabel(loop, "Spatial Loop"), font));
  add(caption("ft-audio-caption-cues", "Cue Caption", zone.at(4.5, 0.3, -5), slotLabel(oneShot, "Cue One Shot And Loop"), font));
}

// ---------------------------------------------------------------------------
// Asset writers

async function createChannel(ctx: FeatureTestContext, name: string, payload: AudioChannelPayload): Promise<string> {
  return (await ctx.createAsset("AudioChannel", FOLDER, name, { payload: record(payload) })).guid;
}

async function createAttenuation(ctx: FeatureTestContext, name: string, payload: SoundAttenuationPayload): Promise<string> {
  return (await ctx.createAsset("SoundAttenuation", FOLDER, name, { payload: record(payload) })).guid;
}

/**
 * Import the first present CC0 slot file as `<name>.<ext>` (the importer
 * writes the current Audio version and the `source` chunk), then save the
 * routing, attenuation, loop and volume through the Audio editor's document
 * path. Returns null, writing nothing, when the slot is empty.
 */
async function importOptionalAudio(
  ctx: FeatureTestContext,
  candidates: readonly string[],
  name: string,
  overrides: Pick<AudioPayload, "loop" | "volume" | "audioChannelGuid" | "soundAttenuationGuid">,
): Promise<string | null> {
  const source = await ctx.host.loadOptional(candidates);
  if (!source) return null;
  const extension = source.path.slice(source.path.lastIndexOf(".") + 1).toLowerCase();
  const created = await ctx.importFile(FOLDER, `${name}.${extension}`, source.bytes);
  const audio = created.find((asset) => asset.header.type === "Audio");
  if (!audio) throw new Error(`FeatureTest could not import ${source.path} as Audio.`);
  const payload: AudioPayload = { ...normalizeAudioPayload(audio.header.payload), ...overrides };
  await ctx.host.saveDocument("audio", audio.path, record(payload));
  return audio.header.guid;
}

function record(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Actors

const PRIMITIVE_SIZE = 1.5;

/** Small speaker mesh plus an Audio Component that plays on start. */
function emitter(
  id: string,
  name: string,
  position: Vec3,
  kind: "cylinder" | "sphere",
  materialGuid: string | null,
  audio: { audioAssetGuid: string | null; loop: boolean; volume: number },
): SerializedActor {
  const size = 0.6 / PRIMITIVE_SIZE;
  return actor(id, name, tf(position), [
    { ...meshComp(`${id}-mesh`, kind, { materialGuid }), transform: tf([0, 0, 0], { scale: [size, size, size] }) },
    comp(`${id}-audio`, "AudioComponent", { ...audio, playOnStart: true }),
  ]);
}

/** Static box `size` meters across (the primitive box is 1.5 m). */
function wall(id: string, name: string, position: Vec3, size: Vec3, materialGuid: string | null): SerializedActor {
  const scale: Vec3 = [size[0] / PRIMITIVE_SIZE, size[1] / PRIMITIVE_SIZE, size[2] / PRIMITIVE_SIZE];
  return actor(id, name, tf(position, { scale }), [meshComp(`${id}-mesh`, "box", { materialGuid })]);
}

function caption(id: string, name: string, position: Vec3, text: string, fontAssetGuid: string | null): SerializedActor {
  return actor(id, name, tf(position), [
    comp(`${id}-text`, "Text3DComponent", {
      text,
      size: 0.45,
      color: [0.9, 0.9, 0.95],
      alignment: "center",
      fontAssetGuid,
    }),
  ]);
}
