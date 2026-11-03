import type { CommandMessage, ControlMessage } from "@haptic/bridge";
import type { ParticleParameterCatalog, ParticleParameterCatalogEntry } from "@haptic/core";
import type { TraceParticleComponent, TraceParticleParameters, TraceParticleState } from "@haptic/debugger";

type ComponentState = { playing: boolean; generation: number };
type PlaybackEnded = Extract<ControlMessage, { type: "particlePlaybackEnded" }>;

const valueKey = (actorGuid: string, componentId: string) => `${actorGuid}\n${componentId}`;

/**
 * Which ParticleComponents this session's commands are playing, so Is Particles Playing can
 * read it, the render host's `particlePlaybackEnded` reports can end it, and trace frames can
 * record and restore it. It owns the Play generation: every Play gets a new one (`prepare`),
 * the render host echoes it, and a report older than the component's latest Play is stale.
 * Stop keeps the generation, so the drain it starts reports as current.
 *
 * It also holds each component's runtime parameter values (Set Particle Parameter; never saved)
 * against the session's parameter catalog, adds them to every `assignParticle` so a respawn or
 * reassignment keeps them, and records them in trace frames.
 */
export class RuntimeParticles {
  private readonly byActor = new Map<string, Map<string, ComponentState>>();
  private nextGeneration = 1;
  private activeSceneGuid: string | undefined;
  private catalog = new Map<string, Map<string, ParticleParameterCatalogEntry>>();
  /** Runtime parameter values by component (`valueKey`), then name. */
  private readonly values = new Map<string, Map<string, number[]>>();
  private readonly warnedNames = new Set<string>();

  /** The session's parameter catalog (`load`, `loadSceneContent`); values already set are kept. */
  replaceCatalog(catalog: ParticleParameterCatalog | undefined): void {
    this.catalog = new Map(Object.entries(catalog ?? {}).map(([guid, entries]) =>
      [guid, new Map(entries.map((entry) => [entry.name, entry]))]));
  }

  /** Every parameter Particle System `systemGuid` declares. */
  parameters(systemGuid: string): ParticleParameterCatalogEntry[] {
    return [...(this.catalog.get(systemGuid)?.values() ?? [])];
  }

  /** The parameter `name` Particle System `systemGuid` declares, if it does. */
  parameter(systemGuid: string, name: string): ParticleParameterCatalogEntry | undefined {
    return this.catalog.get(systemGuid)?.get(name);
  }

  /** True the first time this session uses `name` where no System declares it (one warning per name). */
  firstUnknownUse(name: string): boolean {
    if (this.warnedNames.has(name)) return false;
    this.warnedNames.add(name);
    return true;
  }

  value(actorGuid: string, componentId: string, name: string): number[] | undefined {
    return this.values.get(valueKey(actorGuid, componentId))?.get(name);
  }

  setValue(actorGuid: string, componentId: string, name: string, value: readonly number[]): void {
    const key = valueKey(actorGuid, componentId);
    let values = this.values.get(key);
    if (!values) this.values.set(key, (values = new Map()));
    values.set(name, [...value]);
  }

  clearValue(actorGuid: string, componentId: string, name: string): void {
    const key = valueKey(actorGuid, componentId);
    const values = this.values.get(key);
    values?.delete(name);
    if (values?.size === 0) this.values.delete(key);
  }

  /**
   * Stamps a new generation on every Play (`assignParticle` that plays, `setParticlePlaying` true)
   * that has none, and adds the component's runtime parameter values to its `assignParticle`.
   */
  prepare(command: CommandMessage): CommandMessage {
    if (command.type === "assignParticle") {
      if (!command.particleSystemGuid) return command;
      const runtime = this.values.get(valueKey(command.actorGuid, command.componentId));
      const prepared = runtime ? { ...command, parameters: { ...command.parameters, ...Object.fromEntries(runtime) } } : command;
      if (command.play === false || command.generation !== undefined) return prepared;
      return { ...prepared, generation: this.nextGeneration++ };
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
        this.values.delete(valueKey(command.actorGuid, command.componentId));
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
      if (this.activeSceneGuid !== undefined && command.sceneAssetGuid !== this.activeSceneGuid) {
        this.byActor.clear();
        this.values.clear();
      }
      this.activeSceneGuid = command.sceneAssetGuid;
    }
  }

  /**
   * The render host ended a component's playback. Returns whether the report is current (not
   * made stale by a later Play); a current finish or Stop runs Event On Particles Finished.
   */
  ended(message: PlaybackEnded): boolean {
    const state = this.component(message.actorGuid, message.componentId);
    if (!state || message.generation < state.generation) return false;
    state.playing = false;
    return true;
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
    const parameters: TraceParticleParameters[] = [];
    for (const [key, values] of this.values) {
      const [actorGuid = "", componentGuid = ""] = key.split("\n");
      parameters.push({ actorGuid, componentGuid, values: Object.fromEntries([...values].map(([name, value]) => [name, [...value]])) });
    }
    return { components, nextGeneration: this.nextGeneration, ...(parameters.length ? { parameters } : {}) };
  }

  /**
   * Resumes a trace frame's runtime parameter values: sets each recorded value and resets each
   * value set since, back to the component's override (`overrides`) or, without one, its default.
   */
  restoreParameterCommands(
    state: TraceParticleState,
    overrides: (actorGuid: string, componentId: string) => Readonly<Record<string, readonly number[]>>,
  ): CommandMessage[] {
    const recorded = new Map((state.parameters ?? []).map((entry) => [valueKey(entry.actorGuid, entry.componentGuid), entry]));
    const commands: CommandMessage[] = [];
    for (const [key, values] of [...this.values]) {
      if (recorded.has(key)) continue;
      const [actorGuid = "", componentId = ""] = key.split("\n");
      for (const name of values.keys()) {
        const override = overrides(actorGuid, componentId)[name];
        commands.push({ type: "setParticleParameter", actorGuid, componentId, name, value: override ? [...override] : null });
      }
      this.values.delete(key);
    }
    for (const [key, entry] of recorded) {
      const current = this.values.get(key);
      const override = overrides(entry.actorGuid, entry.componentGuid);
      for (const name of current?.keys() ?? []) {
        if (name in entry.values) continue;
        commands.push({ type: "setParticleParameter", actorGuid: entry.actorGuid, componentId: entry.componentGuid, name,
          value: override[name] ? [...override[name]!] : null });
      }
      this.values.set(key, new Map(Object.entries(entry.values).map(([name, value]) => [name, [...value]])));
      for (const [name, value] of Object.entries(entry.values)) {
        commands.push({ type: "setParticleParameter", actorGuid: entry.actorGuid, componentId: entry.componentGuid, name, value: [...value] });
      }
    }
    return commands;
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
