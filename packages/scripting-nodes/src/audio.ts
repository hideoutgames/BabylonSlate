import {
  pin,
  type GraphPin,
  type NodeDefinition,
  BOOL,
  EXEC,
  FLOAT,
  VEC3,
  assetRef,
  structRef,
  ENGINE_SOUND_HANDLE_STRUCT_ID,
} from "@haptic/scripting";

const SOUND_HANDLE = structRef(ENGINE_SOUND_HANDLE_STRUCT_ID);
const execPins = (): GraphPin[] => [pin("execIn", "exec", "in", EXEC), pin("execOut", "then", "out", EXEC)];
const handleIn = (): GraphPin => pin("handle", "Handle", "in", SOUND_HANDLE);

/** An exec node on a playing sound by its handle. */
function soundAction(id: string, title: string, description: string, inputs: () => GraphPin[], call: (ctx: Parameters<NodeDefinition["codegen"]>[0]) => string): NodeDefinition {
  return {
    id, title, category: "audio", description,
    pins: () => [...execPins(), handleIn(), ...inputs()],
    codegen: (ctx) => {
      ctx.emit(`${call(ctx)};`);
    },
  };
}

/** Volume pins default to 1; codegen clamps the value to 0..1. */
function volumeExpr(ctx: Parameters<NodeDefinition["codegen"]>[0]): string {
  return `Math.min(1, Math.max(0, Number(${ctx.input("volume")})))`;
}

const volumePin = () => pin("volume", "volume", "in", FLOAT, "data", true, 1);

export const audioNodes: NodeDefinition[] = [
  {
    id: "audio.play",
    title: "Play Sound",
    category: "audio",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("asset", "asset", "in", assetRef("Audio")),
      volumePin(),
      pin("handle", "Handle", "out", SOUND_HANDLE),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `${ctx.output("handle")} = ctx.playSound(${ctx.input("asset")}, ${volumeExpr(ctx)});`,
      );
    },
  },
  {
    id: "audio.playAtLocation",
    title: "Play Sound At Location",
    category: "audio",
    description: "Plays the Audio at a fixed world Location. It is heard from there when the Audio has a Sound Attenuation, else like Play Sound.",
    pins: () => [
      ...execPins(),
      pin("asset", "Sound", "in", assetRef("Audio")),
      pin("location", "Location", "in", VEC3),
      volumePin(),
      pin("pitch", "Pitch Multiplier", "in", FLOAT, "data", true, 1),
      pin("handle", "Handle", "out", SOUND_HANDLE),
    ],
    codegen: (ctx) => {
      ctx.emit(`${ctx.output("handle")} = ctx.playSoundAtLocation(${ctx.input("asset")}, ${ctx.input("location")}, ${volumeExpr(ctx)}, ${ctx.input("pitch")});`);
    },
  },
  soundAction("audio.stopSound", "Stop Sound", "Stops the sound at once.", () => [],
    (ctx) => `ctx.stopSoundHandle(${ctx.input("handle")})`),
  soundAction("audio.setSoundVolume", "Set Sound Volume", "Changes the playing sound's volume, from 0 to 1, and ends a fade in progress.", () => [volumePin()],
    (ctx) => `ctx.setSoundVolume(${ctx.input("handle")}, ${ctx.input("volume")})`),
  soundAction("audio.setSoundPitch", "Set Sound Pitch", "Multiplies the Audio's own pitch: 2 plays an octave higher and twice as fast, 0.5 an octave lower. From 0.25 to 4.",
    () => [pin("pitch", "Pitch Multiplier", "in", FLOAT, "data", true, 1)],
    (ctx) => `ctx.setSoundPitch(${ctx.input("handle")}, ${ctx.input("pitch")})`),
  soundAction("audio.fadeIn", "Fade In Sound", "Starts the sound silent and raises it to Volume over Fade In Duration seconds.",
    () => [pin("duration", "Fade In Duration", "in", FLOAT, "data", true, 1), volumePin()],
    (ctx) => `ctx.fadeInSound(${ctx.input("handle")}, ${ctx.input("duration")}, ${ctx.input("volume")})`),
  soundAction("audio.fadeOut", "Fade Out Sound", "Lowers the sound to silent over Fade Out Duration seconds, then stops it.",
    () => [pin("duration", "Fade Out Duration", "in", FLOAT, "data", true, 1)],
    (ctx) => `ctx.fadeOutSound(${ctx.input("handle")}, ${ctx.input("duration")})`),
  {
    id: "audio.isSoundPlaying",
    title: "Is Sound Playing",
    category: "audio",
    pure: true,
    description: "True from Play Sound until the sound ends, is stopped or fades out.",
    pins: () => [handleIn(), pin("playing", "Playing", "out", BOOL)],
    codegen: (ctx) => ({ playing: `ctx.isSoundPlaying(${ctx.input("handle")})` }),
  },
  {
    id: "audio.setChannelVolume",
    title: "Set Channel Volume",
    category: "audio",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("channel", "channel", "in", assetRef("AudioChannel")),
      volumePin(),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.setChannelVolume(${ctx.input("channel")}, ${volumeExpr(ctx)});`,
      );
    },
  },
  {
    id: "audio.setGlobalVolume",
    title: "Set Global Volume",
    category: "audio",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      volumePin(),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.setGlobalVolume(${volumeExpr(ctx)});`);
    },
  },
];
