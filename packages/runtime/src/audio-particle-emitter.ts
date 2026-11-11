import type { CommandMessage } from "@haptic/bridge";
import { parseParticleRetrigger } from "@haptic/core";
import type { Actor, ActorComponent } from "@haptic/object-model";
import type { OwnerAdmission } from "./owner-admission";
import { particleComponentOverrides } from "./particle-parameter-bindings";
import type { RuntimeVoices } from "./runtime-voices";
import type { ScriptHostServices } from "./script-host";

interface AudioParticleEmitterHost {
  slot(actor: Actor): number | undefined;
  frameId(): number;
  emit(command: CommandMessage): void;
}

/**
 * Sends Audio and Particle component playback commands: Play On Start voices
 * and particle systems when an actor is realized or a component refreshes,
 * and the stops the driver sends before an actor's `despawn`. It holds no
 * state; the driver decides when each runs.
 */
export class AudioParticleEmitter {
  /** Authored playback starts once the actor's owner can run, else waits in its owner queue. */
  private readonly admission: Pick<OwnerAdmission, "canRun" | "run">;
  private readonly host: AudioParticleEmitterHost;

  constructor(admission: Pick<OwnerAdmission, "canRun" | "run">, host: AudioParticleEmitterHost) {
    this.admission = admission;
    this.host = host;
  }

  emitAudio(actor: Actor): void {
    if (!this.admission.canRun(actor)) {
      this.admission.run(actor, () => this.emitAudio(actor));
      return;
    }
    for (const component of actor.components) {
      if (component.destroyed || component.classId !== "AudioComponent") continue;
      const playOnStart = component.getVariable("playOnStart") !== false;
      const assetGuid = component.getVariable("audioAssetGuid");
      if (!playOnStart || typeof assetGuid !== "string" || !assetGuid) continue;
      const volume = Number(component.getVariable("volume") ?? 1);
      this.host.emit({
        type: "playSound",
        assetGuid,
        volume: Number.isFinite(volume) ? volume : 1,
        frameId: this.host.frameId(),
        loop: component.getVariable("loop") === true,
        voiceId: component.guid,
        emitterActorGuid: actor.guid,
      });
    }
  }

  /** A refreshed Audio component applies its volume to the playing voice. */
  emitVoiceGain(component: ActorComponent): void {
    const volume = Number(component.getVariable("volume") ?? 1);
    this.host.emit({
      type: "setVoiceGain",
      voiceId: component.guid,
      volume: Number.isFinite(volume) ? volume : 1,
    });
  }

  stopAudio(actor: Actor): void {
    for (const component of actor.components) {
      if (component.classId !== "AudioComponent") continue;
      this.host.emit({ type: "stopSound", voiceId: component.guid });
    }
  }

  emitParticles(actor: Actor): void {
    const slotId = this.host.slot(actor);
    if (slotId === undefined) return;
    for (const component of actor.components) {
      if (component.destroyed || component.classId !== "ParticleComponent") {
        continue;
      }
      const assetGuid =
        (typeof component.getVariable("particleSystemGuid") === "string"
          ? component.getVariable("particleSystemGuid")
          : null) ?? component.assetGuid;
      if (typeof assetGuid !== "string" || !assetGuid) continue;
      const sortingLayer = component.getVariable("sortingLayer");
      const orderInLayer = component.getVariable("orderInLayer");
      const retrigger = parseParticleRetrigger(component.getVariable("retrigger"));
      this.host.emit({
        type: "assignParticle",
        slotId,
        actorGuid: actor.guid,
        componentId: component.guid,
        particleSystemGuid: assetGuid,
        play: this.admission.canRun(actor) && component.getVariable("playOnStart") !== false,
        sortingLayer:
          typeof sortingLayer === "string" && sortingLayer.trim() !== ""
            ? sortingLayer
            : "Default",
        orderInLayer:
          typeof orderInLayer === "number" && Number.isFinite(orderInLayer)
            ? Math.round(orderInLayer)
            : 0,
        ...(retrigger === "restart" ? { retrigger } : {}),
        ...particleOverridesField(component),
      });
      if (component.getVariable("playOnStart") !== false && !this.admission.canRun(actor)) {
        this.admission.run(actor, () => this.host.emit({ type: "setParticlePlaying", actorGuid: actor.guid,
          componentId: component.guid, playing: true }));
      }
    }
  }

  /** Clears the actor's particle systems; one without a render slot never had any assigned. */
  stopParticles(actor: Actor): void {
    const slotId = this.host.slot(actor);
    if (slotId === undefined) return;
    for (const component of actor.components) {
      if (component.classId !== "ParticleComponent") continue;
      this.host.emit({
        type: "assignParticle",
        slotId,
        actorGuid: actor.guid,
        componentId: component.guid,
        particleSystemGuid: null,
      });
    }
  }
}

interface AudioHostDeps {
  frameId(): number;
  /** Names a script voice that has no id, so it can be traced, stopped and resumed. */
  scriptVoiceId(): string;
  emit(command: CommandMessage): void;
  /** The session's live voices and their fades (`RuntimeVoices`). */
  voices: Pick<RuntimeVoices, "isLive" | "fade" | "volumeOf">;
}

/** Script audio and particle calls: sounds, particle playback and mixer volumes. */
export function createAudioHostBindings(deps: AudioHostDeps): Pick<ScriptHostServices,
  "playSound" | "stopSound" | "scriptVoiceId" | "soundVoices" | "setParticlePlaying" | "emitParticleBurst" |
  "setChannelVolume" | "setGlobalVolume"> {
  return {
    playSound: (asset, volume, options) => {
      deps.emit({
        type: "playSound",
        assetGuid: String(asset ?? ""),
        volume: Number(volume ?? 1),
        frameId: deps.frameId(),
        emitterActorGuid: options?.emitterActorGuid ?? null,
        loop: options?.loop,
        voiceId: options?.voiceId ?? deps.scriptVoiceId(),
        ...(options?.location ? { location: options.location } : {}),
        ...(options?.pitch !== undefined && options.pitch !== 1 ? { pitch: options.pitch } : {}),
      });
    },
    stopSound: (voiceId) => {
      deps.emit({ type: "stopSound", voiceId });
    },
    scriptVoiceId: () => deps.scriptVoiceId(),
    soundVoices: {
      isPlaying: (voiceId) => deps.voices.isLive(voiceId),
      volume: (voiceId) => deps.voices.volumeOf(voiceId),
      // Only voices this session started and has not stopped: a stale handle sends nothing.
      setVolume: (voiceId, volume) => {
        if (deps.voices.isLive(voiceId)) for (const command of deps.voices.fade(voiceId, 0, volume)) deps.emit(command);
      },
      setPitch: (voiceId, pitch) => {
        if (deps.voices.isLive(voiceId)) deps.emit({ type: "setVoicePitch", voiceId, pitch });
      },
      fade: (voiceId, seconds, to, options) => {
        for (const command of deps.voices.fade(voiceId, seconds, to, options)) deps.emit(command);
      },
    },
    setParticlePlaying: (actorGuid, playing, componentId, restart) => {
      deps.emit({
        type: "setParticlePlaying",
        actorGuid: String(actorGuid ?? ""),
        playing: Boolean(playing),
        ...(componentId ? { componentId: String(componentId) } : {}),
        ...(restart && playing ? { restart: true } : {}),
      });
    },
    emitParticleBurst: (actorGuid, count, slot, componentId) => {
      const particles = Math.floor(Number(count));
      if (!(particles > 0)) return;
      const index = Math.floor(Number(slot));
      deps.emit({
        type: "emitParticleBurst",
        actorGuid: String(actorGuid ?? ""),
        count: particles,
        ...(Number.isFinite(index) && index >= 0 ? { slot: index } : {}),
        ...(componentId ? { componentId: String(componentId) } : {}),
      });
    },
    setChannelVolume: (channelGuid, volume) => {
      deps.emit({
        type: "setChannelVolume",
        channelGuid: String(channelGuid ?? ""),
        volume: Number(volume ?? 1),
      });
    },
    setGlobalVolume: (volume) => {
      deps.emit({
        type: "setGlobalVolume",
        volume: Number(volume ?? 1),
      });
    },
  };
}

/** `assignParticle.parameters` from the component's Parameter Overrides, omitted when it has none. */
function particleOverridesField(component: ActorComponent): { parameters?: Record<string, number[]> } {
  const overrides = particleComponentOverrides(component);
  return Object.keys(overrides).length ? { parameters: overrides } : {};
}
