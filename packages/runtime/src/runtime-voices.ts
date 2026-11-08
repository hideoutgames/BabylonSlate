import type { CommandMessage } from "@haptic/bridge";
import { createSeededRng, type Rng } from "@haptic/core";
import type { TraceAudioState, TraceVoice } from "@haptic/debugger";

type LiveVoice = Omit<TraceVoice, "elapsedSeconds"> & { startedAt: number };
/** A volume ramp (Fade In / Fade Out Sound): `from` to `to` over `seconds`, then a stop when `stopAtEnd`. */
type VoiceFade = { from: number; to: number; seconds: number; elapsed: number; stopAtEnd: boolean };
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
  private readonly fades = new Map<string, VoiceFade>();
  private readonly seed: () => number;
  private rng: Rng | null = null;
  private clockSeconds = 0;
  private nextScriptVoice = 1;
  private activeSceneGuid: string | undefined;

  /** `seed` is read at the first draw: the session seed. */
  constructor(seed: () => number) {
    this.seed = seed;
  }

  /**
   * A tick starts: voices started from now on are that many seconds younger. Returns the commands that move each
   * fading voice's volume on by `dtSeconds`, and stop a voice whose fade out has finished.
   */
  advance(dtSeconds: number): CommandMessage[] {
    this.clockSeconds += dtSeconds;
    if (!this.fades.size) return [];
    const commands: CommandMessage[] = [];
    for (const [voiceId, fade] of [...this.fades]) {
      fade.elapsed += dtSeconds;
      commands.push(...this.fadeCommands(voiceId, fade));
    }
    return commands;
  }

  /**
   * Ramp a live voice's play-call volume to `to` over `seconds` of real time, from `from` (its current volume when
   * omitted), replacing any fade it had. Returns the commands for the ramp's start: the whole change, and the stop,
   * when `seconds` is not above 0.
   */
  fade(voiceId: string, seconds: number, to: number, options: { from?: number; stopAtEnd?: boolean } = {}): CommandMessage[] {
    const voice = this.live.get(voiceId);
    if (!voice) return [];
    const fade: VoiceFade = {
      from: options.from ?? voice.volume,
      to,
      seconds: Number.isFinite(seconds) ? Math.max(0, seconds) : 0,
      elapsed: 0,
      stopAtEnd: options.stopAtEnd === true,
    };
    this.fades.set(voiceId, fade);
    return this.fadeCommands(voiceId, fade);
  }

  private fadeCommands(voiceId: string, fade: VoiceFade): CommandMessage[] {
    const done = fade.elapsed >= fade.seconds;
    const volume = done ? fade.to : fade.from + (fade.to - fade.from) * (fade.elapsed / fade.seconds);
    const commands: CommandMessage[] = [{ type: "setVoiceGain", voiceId, volume }];
    if (done) {
      this.fades.delete(voiceId);
      if (fade.stopAtEnd) commands.push({ type: "stopSound", voiceId });
    }
    return commands;
  }

  /** Whether this session started the voice and it has not stopped or ended. */
  isLive(voiceId: string): boolean {
    return this.live.has(voiceId);
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

  /** A stable id for a script Play Sound that names no voice: `script:<n>`, whose `n` is its Sound Handle's Id. */
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
        this.fades.clear();
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
    this.fades.delete(voiceId);
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
