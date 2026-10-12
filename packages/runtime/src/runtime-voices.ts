import type { CommandMessage } from "@babylonslate/bridge";
import { createSeededRng, type Rng } from "@babylonslate/core";
import type { TraceAudioState, TraceVoice } from "@babylonslate/debugger";

type LiveVoice = Omit<TraceVoice, "elapsedSeconds"> & { startedAt: number };
type PlaySound = Extract<CommandMessage, { type: "playSound" }>;

/** Separates the voice draws from the World and script streams that share the session seed. */
const VOICE_STREAM_SALT = 0x564f4943;

/**
 * The voices this session's commands started and have not stopped, so trace
 * frames can record them and a trace restore can resume them. It watches the
 * outgoing `playSound` / `stopSound` / `setVoiceGain` commands and the host's
 * `audioVoiceEnded` reports. Voice age is undilated fixed steps: audio plays in
 * real time, which the fixed step tracks, while `slomo` only slows simulation.
 *
 * It also draws each new voice's clip and pitch choice (`prepare`) from a
 * seeded stream of its own, so traces record the choice and restores replay it,
 * and its voice-age clock (undilated simulation time, excluding pauses) is
 * the audio clock restored voices catch up by.
 */
export class RuntimeVoices {
  private readonly live = new Map<string, LiveVoice>();
  /** Ids of the live voices a trace restore started; every `live` removal also clears its id. */
  private readonly restored = new Set<string>();
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

  /** The audio clock: undilated simulation seconds this session has ticked, excluding pauses. */
  get audioTime(): number {
    return this.clockSeconds;
  }

  /** True while a voice a trace restore started is live; the host then needs `audioSimTime`. */
  get hasRestoredVoices(): boolean {
    return this.restored.size > 0;
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
        startedAt: this.clockSeconds - (command.startOffsetSeconds ?? 0),
      };
      this.live.set(voiceId, voice);
      if (command.restoredAtSeconds !== undefined) this.restored.add(voiceId);
    } else if (command.type === "stopSound") {
      this.drop(command.voiceId);
    } else if (command.type === "setVoiceGain") {
      const voice = this.live.get(command.voiceId);
      if (voice) voice.volume = command.volume;
    } else if (command.type === "activeScene") {
      // Hosts reset their audio session when the active Scene changes from the boot Scene onward.
      if (this.activeSceneGuid !== undefined && command.sceneAssetGuid !== this.activeSceneGuid) {
        this.live.clear();
        this.restored.clear();
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
    this.restored.delete(voiceId);
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

  /**
   * Commands that make the host's voices the recorded ones: `stopSound` for
   * each live voice the frame lacks (start order), then `playSound` at its
   * recorded offset and clip and pitch draws for each recorded voice (recorded
   * start order), stamped with the audio clock at the restore.
   */
  restoreCommands(state: TraceAudioState, frameId: number): CommandMessage[] {
    const recorded = new Set(state.voices.map((voice) => voice.voiceId));
    const commands: CommandMessage[] = [];
    for (const voiceId of this.live.keys()) {
      if (!recorded.has(voiceId)) commands.push({ type: "stopSound", voiceId });
    }
    this.nextScriptVoice = state.nextScriptVoice;
    for (const voice of state.voices) {
      commands.push({
        type: "playSound",
        assetGuid: voice.assetGuid,
        volume: voice.volume,
        frameId,
        ...(voice.emitterActorGuid ? { emitterActorGuid: voice.emitterActorGuid } : {}),
        ...(voice.loop !== undefined ? { loop: voice.loop } : {}),
        voiceId: voice.voiceId,
        ...(voice.elapsedSeconds > 0 ? { startOffsetSeconds: voice.elapsedSeconds } : {}),
        ...rolls(voice),
        restoredAtSeconds: this.clockSeconds,
      });
    }
    return commands;
  }
}

function rolls(source: Pick<PlaySound, "clipRoll" | "pitchRoll">): Pick<PlaySound, "clipRoll" | "pitchRoll"> {
  return {
    ...(source.clipRoll !== undefined ? { clipRoll: source.clipRoll } : {}),
    ...(source.pitchRoll !== undefined ? { pitchRoll: source.pitchRoll } : {}),
  };
}
