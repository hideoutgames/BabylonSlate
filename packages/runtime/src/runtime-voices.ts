import type { CommandMessage } from "@haptic/bridge";
import { createSeededRng, type Rng } from "@haptic/core";
import type { TraceAudioState, TraceVoice } from "@haptic/debugger";

type LiveVoice = Omit<TraceVoice, "elapsedSeconds"> & { startedAt: number };
type PlaySound = Extract<CommandMessage, { type: "playSound" }>;

/** Separates the voice draws from the World and script streams that share the session seed. */
const VOICE_STREAM_SALT = 0x564f4943;

/**
 * The voices this session's commands started and have not stopped, so trace
 * frames can record them. It watches the outgoing `playSound` / `stopSound` /
 * `setVoiceGain` commands and the host's `audioVoiceEnded` reports. Voice age
 * is undilated fixed steps (excluding pauses): audio plays in real time, which
 * the fixed step tracks, while `slomo` only slows simulation.
 *
 * It also draws each new voice's clip and pitch choice (`prepare`) from a
 * seeded stream of its own, so a run with the same seed plays the same clips
 * and pitches and traces record the choice.
 */
export class RuntimeVoices {
  private readonly live = new Map<string, LiveVoice>();
  private readonly seed: () => number;
  private rng: Rng | null = null;
  private clockSeconds = 0;
  private nextScriptVoice = 1;
  private activeSceneGuid: string | undefined;

  /** `seed` is read at the first draw: the session seed. */
  constructor(seed: () => number) {
    this.seed = seed;
  }

  /** A tick starts: voices started from now on are that many seconds younger. */
  advance(dtSeconds: number): void {
    this.clockSeconds += dtSeconds;
  }

  /** Gives a `playSound` that names an asset but no clip or pitch draws its draws. */
  prepare(command: CommandMessage): CommandMessage {
    if (command.type !== "playSound" || !command.assetGuid) return command;
    if (command.clipRoll !== undefined && command.pitchRoll !== undefined) return command;
    this.rng ??= createSeededRng((this.seed() ^ VOICE_STREAM_SALT) >>> 0);
    return {
      ...command,
      clipRoll: command.clipRoll ?? this.rng.nextFloat(),
      pitchRoll: command.pitchRoll ?? this.rng.nextFloat(),
    };
  }

  /** Each live voice and the guid of the object that played it (its emitter), in start order. */
  liveVoiceOwners(): Array<[voiceId: string, ownerGuid: string | null]> {
    return [...this.live.values()].map((voice) => [voice.voiceId, voice.emitterActorGuid ?? null]);
  }

  /** A stable id for a script Play Sound that names no voice. */
  scriptVoiceId(): string {
    return `script:${this.nextScriptVoice++}`;
  }

  observe(command: CommandMessage): void {
    if (command.type === "playSound") {
      const voiceId = command.voiceId?.trim();
      // A Play Sound with no asset (an unset Play Sound pin) starts no voice.
      if (!voiceId || !command.assetGuid) return;
      // A replayed voice id restarts and moves to the end of the start order.
      this.drop(voiceId);
      const voice: LiveVoice = {
        voiceId,
        assetGuid: command.assetGuid,
        volume: command.volume,
        ...(command.loop !== undefined ? { loop: command.loop } : {}),
        ...(command.emitterActorGuid ? { emitterActorGuid: command.emitterActorGuid } : {}),
        ...rolls(command),
        startedAt: this.clockSeconds,
      };
      this.live.set(voiceId, voice);
    } else if (command.type === "stopSound") {
      this.drop(command.voiceId);
    } else if (command.type === "setVoiceGain") {
      const voice = this.live.get(command.voiceId);
      if (voice) voice.volume = command.volume;
    } else if (command.type === "activeScene") {
      // Hosts reset their audio session when the active Scene changes from the boot Scene onward.
      if (this.activeSceneGuid !== undefined && command.sceneAssetGuid !== this.activeSceneGuid) {
        this.live.clear();
      }
      this.activeSceneGuid = command.sceneAssetGuid;
    }
  }

  /** The host finished a non-looping voice. */
  ended(voiceId: string): void {
    this.drop(voiceId);
  }

  private drop(voiceId: string): void {
    this.live.delete(voiceId);
  }

  traceState(): TraceAudioState {
    return {
      voices: [...this.live.values()].map(({ startedAt, ...voice }) => ({
        ...voice,
        elapsedSeconds: Math.max(0, this.clockSeconds - startedAt),
      })),
      nextScriptVoice: this.nextScriptVoice,
    };
  }
}

function rolls(source: Pick<PlaySound, "clipRoll" | "pitchRoll">): Pick<PlaySound, "clipRoll" | "pitchRoll"> {
  return {
    ...(source.clipRoll !== undefined ? { clipRoll: source.clipRoll } : {}),
    ...(source.pitchRoll !== undefined ? { pitchRoll: source.pitchRoll } : {}),
  };
}
