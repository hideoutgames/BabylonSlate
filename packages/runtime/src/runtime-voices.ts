import type { CommandMessage } from "@babylonslate/bridge";
import type { TraceAudioState, TraceVoice } from "@babylonslate/debugger";

type LiveVoice = Omit<TraceVoice, "elapsedSeconds"> & { startedAt: number };

/**
 * The voices this session's commands started and have not stopped, so trace
 * frames can record them and a trace restore can resume them. It watches the
 * outgoing `playSound` / `stopSound` / `setVoiceGain` commands and the host's
 * `audioVoiceEnded` reports. Time is undilated fixed steps: audio plays in
 * real time, which the fixed step tracks, while `slomo` only slows simulation.
 */
export class RuntimeVoices {
  private readonly live = new Map<string, LiveVoice>();
  private clockSeconds = 0;
  private nextScriptVoice = 1;
  private activeSceneGuid: string | undefined;

  /** A tick starts: voices started from now on are that many seconds younger. */
  advance(dtSeconds: number): void {
    this.clockSeconds += dtSeconds;
  }

  /** A stable id for a script Play Sound that names no voice. */
  scriptVoiceId(): string {
    return `script:${this.nextScriptVoice++}`;
  }

  observe(command: CommandMessage): void {
    if (command.type === "playSound") {
      const voiceId = command.voiceId?.trim();
      if (!voiceId) return;
      // Component Stop sends a Play Sound without an asset for its voice.
      if (!command.assetGuid) {
        this.live.delete(voiceId);
        return;
      }
      // A replayed voice id restarts and moves to the end of the start order.
      this.live.delete(voiceId);
      this.live.set(voiceId, {
        voiceId,
        assetGuid: command.assetGuid,
        volume: command.volume,
        ...(command.loop !== undefined ? { loop: command.loop } : {}),
        ...(command.emitterActorGuid ? { emitterActorGuid: command.emitterActorGuid } : {}),
        startedAt: this.clockSeconds - (command.startOffsetSeconds ?? 0),
      });
    } else if (command.type === "stopSound") {
      this.live.delete(command.voiceId);
    } else if (command.type === "setVoiceGain") {
      const voice = this.live.get(command.voiceId);
      if (voice) voice.volume = command.volume;
    } else if (command.type === "activeScene") {
      // Hosts reset their audio session when the active Scene changes from the boot Scene onward.
      if (this.activeSceneGuid !== undefined && command.sceneAssetGuid !== this.activeSceneGuid) this.live.clear();
      this.activeSceneGuid = command.sceneAssetGuid;
    }
  }

  /** The host finished a non-looping voice. */
  ended(voiceId: string): void {
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

  /**
   * Commands that make the host's voices the recorded ones: `stopSound` for
   * each live voice the frame lacks (start order), then `playSound` at its
   * recorded offset for each recorded voice (recorded start order).
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
      });
    }
    return commands;
  }
}
