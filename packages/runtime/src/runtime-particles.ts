import type { CommandMessage, ControlMessage } from "@haptic/bridge";
import type { TraceParticleComponent, TraceParticleState } from "@haptic/debugger";

type ComponentState = { playing: boolean; generation: number };
type PlaybackEnded = Extract<ControlMessage, { type: "particlePlaybackEnded" }>;

/**
 * Which ParticleComponents this session's commands are playing, so Is Particles Playing can
 * read it, the render host's `particlePlaybackEnded` reports can end it, and trace frames can
 * record and restore it. It owns the Play generation: every Play gets a new one (`prepare`),
 * the render host echoes it, and a report older than the component's latest Play is stale.
 * Stop keeps the generation, so the drain it starts reports as current.
 */
export class RuntimeParticles {
  private readonly byActor = new Map<string, Map<string, ComponentState>>();
  private nextGeneration = 1;
  private activeSceneGuid: string | undefined;

  /** Stamps a new generation on every Play (`assignParticle` that plays, `setParticlePlaying` true) that has none. */
  prepare(command: CommandMessage): CommandMessage {
    if (command.type === "assignParticle") {
      if (!command.particleSystemGuid || command.play === false || command.generation !== undefined) return command;
      return { ...command, generation: this.nextGeneration++ };
    }
    if (command.type === "setParticlePlaying" && command.playing && command.generation === undefined) {
      return { ...command, generation: this.nextGeneration++ };
    }
    return command;
  }

  observe(command: CommandMessage): void {
    if (command.type === "assignParticle") {
      if (!command.particleSystemGuid) {
        const components = this.byActor.get(command.actorGuid);
        components?.delete(command.componentId);
        if (components?.size === 0) this.byActor.delete(command.actorGuid);
        return;
      }
      let components = this.byActor.get(command.actorGuid);
      if (!components) this.byActor.set(command.actorGuid, (components = new Map()));
      components.set(command.componentId, { playing: command.play !== false, generation: command.generation ?? 0 });
    } else if (command.type === "setParticlePlaying") {
      for (const [, state] of this.components(command.actorGuid, command.componentId)) {
        state.playing = command.playing;
        if (command.playing && command.generation !== undefined) state.generation = command.generation;
      }
    } else if (command.type === "activeScene") {
      // The render host retires every particle system when the active Scene changes.
      if (this.activeSceneGuid !== undefined && command.sceneAssetGuid !== this.activeSceneGuid) this.byActor.clear();
      this.activeSceneGuid = command.sceneAssetGuid;
    }
  }

  /**
   * The render host ended a component's playback. Returns whether the report is current and
   * should run Event On Particles Finished (a finish or a Stop; a failure only ends playback).
   */
  ended(message: PlaybackEnded): boolean {
    const state = this.component(message.actorGuid, message.componentId);
    if (!state || message.generation < state.generation) return false;
    state.playing = false;
    return message.reason !== "failed";
  }

  /** True while the component (or, without `componentId`, any ParticleComponent of the actor) plays. */
  isPlaying(actorGuid: string, componentId?: string): boolean {
    return this.components(actorGuid, componentId).some(([, state]) => state.playing);
  }

  traceState(): TraceParticleState {
    const components: TraceParticleComponent[] = [];
    for (const [actorGuid, states] of this.byActor) {
      for (const [componentGuid, state] of states) components.push({ actorGuid, componentGuid, ...state });
    }
    return { components, nextGeneration: this.nextGeneration };
  }

  /**
   * Resumes a trace frame's playback flags and generations on the tracked components: Play with
   * the recorded generation for each one that was playing (so the render host echoes it), and Stop
   * for each one that plays now but was not playing then.
   */
  restoreCommands(state: TraceParticleState): CommandMessage[] {
    this.nextGeneration = Math.max(this.nextGeneration, state.nextGeneration);
    const recorded = new Map(state.components.map((entry) => [`${entry.actorGuid}:${entry.componentGuid}`, entry]));
    const commands: CommandMessage[] = [];
    for (const [actorGuid, states] of this.byActor) {
      for (const [componentId, current] of states) {
        const entry = recorded.get(`${actorGuid}:${componentId}`);
        if (entry?.playing) {
          commands.push({ type: "setParticlePlaying", actorGuid, componentId, playing: true, generation: entry.generation });
        } else if (current.playing) {
          commands.push({ type: "setParticlePlaying", actorGuid, componentId, playing: false });
        }
        if (entry) current.generation = entry.generation;
      }
    }
    return commands;
  }

  private component(actorGuid: string, componentId: string): ComponentState | undefined {
    return this.byActor.get(actorGuid)?.get(componentId);
  }

  private components(actorGuid: string, componentId?: string): Array<[string, ComponentState]> {
    const states = this.byActor.get(actorGuid);
    if (!states) return [];
    if (!componentId) return [...states];
    const state = states.get(componentId);
    return state ? [[componentId, state]] : [];
  }
}
