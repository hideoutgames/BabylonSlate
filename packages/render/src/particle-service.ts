import { isSceneStreamSlotPending, registerSceneStreamParticle } from "./scene-stream-admission";
import {
  Mesh,
  type AbstractEngine,
  type AbstractMesh,
  type BaseTexture,
  type Effect,
  type IParticleSystem,
  type NodeMaterial,
  type NodeParticleSystemSet,
  type ParticleSystem,
  type GPUParticleSystem,
  type Scene,
} from "@babylonjs/core";
import {
  particleEmitterChangeTier,
  particleEmitterMaterialGuid,
  resolveBasicEmitterPlan,
  stableStringify,
  type ParticleEmitterChangeTier,
  type ParticleEmitterPayload,
  type ParticleLibrary,
  type ParticleLibraryEmitter,
  type ParticleSimBackend,
  type ParticleSystemPayload,
} from "@haptic/assets";
import type { CommandMessage } from "@haptic/bridge";
import { DEFAULT_SORTING_LAYERS, PARTICLE_GHOSTS_PER_COMPONENT, type ParticlePlaybackEndReason, type ParticleSpace } from "@haptic/core";
import {
  lowerParticleGraphDocumentCached,
  particleGraphCompileKey,
  type ParticleBuildPlan,
  type ParticleGraphDocument,
  type ParticleGraphLowerResult,
} from "@haptic/particle-graph";
import type { ResourceLease } from "./resource-cache";
import { BUILTIN_PARTICLE_NOISE, particleNoisePixelsFrom, type ParticleNoisePixels, type ParticleNoiseSource } from "./particle-noise";
import { PREVIEW_OWNER_MESH, meshGeometryRelativeTo, type ParticleMeshGeometry, type ParticleMeshShapeSource } from "./particle-mesh-shape";
import { createBasicEmissionDriver, createManualEmission, type BasicEmissionDriver, type ManualEmission } from "./particle-emission-driver";
import { describeParticleThrow, realizeParticleGraph, type ParticleGraphCompileCode } from "./particle-graph-realize";
import {
  applyBasicEmitterPlan,
  bindParticleMaterial,
  boundParticlePreparation,
  createBabylonParticleSystem,
  gpuParticlesSupported,
  particleLifetimeBound,
  particleSimBackend,
  particleSimulationDelta,
} from "./particle-system-factory";
import { markSceneReadinessDirty } from "./scene-perf";
import { applySortingToParticleSystem, resolveSortingLayer, type SortingLayerResolution } from "./sorting";
import { drawWhateverTheView } from "./play-view-culling";
import { effectDrawnOn } from "./first-draw-stats";
import { FIRST_DRAWS_PER_FRAME } from "./variant-pipeline-warmup";

export type { ParticleLibrary, ParticleLibraryEmitter } from "@haptic/assets";
export type ParticleDiagnosticCode =
  | "particle.unknown_system"
  | "particle.unknown_emitter"
  | "particle.missing_material"
  | "particle.graph_invalid"
  | ParticleGraphCompileCode
  | "particle.apply_failed"
  | "particle.burst_not_playing"
  | "particle.noise_texture_unavailable"
  | "particle.mesh_missing";
/**
 * Slot-level problems carry the emitter guid; bundle-level ones the Particle System guid.
 * Particle Graph problems also carry the graph node (and pin) they are anchored to.
 */
export type ParticleServiceDiagnostic = {
  code: ParticleDiagnosticCode;
  message: string;
  /** Debug-level notes (a burst on a component that is not playing); others are warnings. */
  severity?: "verbose";
  assetGuid?: string;
  nodeId?: string;
  pinId?: string;
};
export type ParticleStats = { systems: number; playing: number; gpu: boolean; gpuSystems: number; graphSystems: number };
export const particleStats: ParticleStats = { systems: 0, playing: 0, gpu: false, gpuSystems: 0, graphSystems: 0 };
/** GPU `active` is the claimed slot ring, not a live count, so it is marked approximate. */
export type ParticlePreviewStats = {
  active: number;
  capacity: number;
  backend: "gpu" | "cpu" | "mixed" | "none";
  approximate: boolean;
};
export type ParticleMaterialOwner = { scene: Scene; instanceKey: string };
/** `particlePlaybackEnded` without its message type: one component stopped playing. */
export type ParticlePlaybackEndedReport = {
  actorGuid: string;
  componentId: string;
  generation: number;
  reason: ParticlePlaybackEndReason;
};
/** `ready-stopped` includes a released bundle (a finished Once System), which replays on its next Play. */
export type ParticlePlaybackState = "preparing" | "ready-stopped" | "playing" | "draining" | "failed";
type Assignment = Extract<CommandMessage, { type: "assignParticle" }>;
type PlaybackState = ParticlePlaybackState | "retired";
type SlotBase = {
  /** Position in the Particle System's emitter list. */
  index: number;
  emitterGuid: string;
  system: IParticleSystem;
  lease: ResourceLease<NodeMaterial>;
  pending: number;
  /** Authored simulation speed; the live `updateSpeed` is this × the time scale, or 0 while halted. */
  updateSpeed: number;
  /** Native `start()` ran. Systems readied while paused start on resume, so prewarm runs at speed. */
  started: boolean;
  /** Native stop (a finished Once emitter) or drain; the emission driver is halted. */
  stopped: boolean;
  /** The emitter runs Once (a one-shot run that Overlap retriggers while it plays). */
  once: boolean;
  cancel: Array<() => void>;
};
/** One native system per prepared slot. */
type BasicSlot = SlotBase & {
  kind: "basic";
  gpu: boolean;
  backend: ParticleSimBackend;
  /** Source payload, diffed by `updateLibrary`. */
  payload: ParticleEmitterPayload;
  driver: BasicEmissionDriver;
  /** GPU prewarm runs inside the first ready render and would consume a queued burst, so the driver waits for that draw. */
  prewarmPending: boolean;
  lifetime: number;
  drainedTime: number;
  /** Scene frame of the last counted step; -1 before the first. */
  lastFrame: number;
};
/** A Particle Graph slot: always a CPU `ParticleSystem` built from Node Particle blocks. */
type GraphSlot = SlotBase & {
  kind: "graph";
  gpu: false;
  system: ParticleSystem;
  /** Owns every block; disposing it disposes the system and its readiness texture. */
  set: NodeParticleSystemSet;
  /** Position-free plan hash; a change rebuilds only this slot. */
  compileKey: string;
  /** A change rebinds the Material on the running system. */
  materialGuid: string;
  /** Scripted bursts (`emitParticleBurst`) through Babylon's manual emission, queued after a rendered frame. */
  manual: ManualEmission;
  requestedBurst: number;
};
type SlotRecord = BasicSlot | GraphSlot;
/** A new native slot and, for graphs, Babylon's build promises. */
type CreatedSlot = { record: SlotRecord; buildReady?: Promise<void> };
/** What every slot of one preparation shares. */
type SlotContext = {
  host: Scene;
  node: Mesh;
  sorting: SortingLayerResolution;
  backend: ParticleSimBackend;
  space: ParticleSpace;
  generation: number;
};
/**
 * An overlapped run (Retrigger Overlap): a bundle whose emitters were stopped when a new Play
 * started, left to drain on its own emitter node and then disposed. It never reports.
 */
type Ghost = { records: SlotRecord[]; node: Mesh | null; cancel: Array<() => void> };
/** The library entries a bundle was prepared from, including skipped slots. */
type BundleSource = {
  system: ParticleSystemPayload | null;
  emitters: Map<string, ParticleLibraryEmitter | undefined>;
  skipped: Set<string>;
};
type LiveComponent = {
  key: string;
  command: Assignment;
  desiredPlaying: boolean;
  /** The worker's generation of the latest Play, echoed in `onPlaybackEnded` (0 for previews). */
  playGeneration: number;
  /** Why the current drain began: a Once system finished, or Stop. */
  endReason?: "finished" | "stopped";
  state: PlaybackState;
  generation: number;
  scene: Scene | null;
  node: Mesh | null;
  systems: SlotRecord[];
  /** Overlapped runs still draining, oldest first (at most `PARTICLE_GHOSTS_PER_COMPONENT`). */
  ghosts: Ghost[];
  source: BundleSource | null;
  cancel: Array<() => void>;
  building: boolean;
  /** Stops the bound on a preparation that waits for its Materials (`boundParticlePreparation`). */
  stopBound?: () => void;
  preparationCheck?: () => void;
  /** Native/resource failure, distinct from a bundle whose authored slots were skipped. */
  preparationFailed?: boolean;
  /** Play's load: a library system no component plays, prepared for the starting-state draw only (`prepareSpawnableSystems`). */
  warm?: boolean;
};
/** An edit's tier, and whether it needs the whole bundle prepared again. */
type LibraryChange = { tier: ParticleEmitterChangeTier; bundle: boolean };
let nextServiceId = 0;
const emptyLibrary = (): ParticleLibrary => ({ emitters: new Map(), systems: new Map() });
/** Every record of an entry: its bundle's, then its ghosts'. */
const allRecords = (entry: LiveComponent): SlotRecord[] => [...entry.systems, ...entry.ghosts.flatMap((ghost) => ghost.records)];
/**
 * Whether stopped slots have no particles left. A claimed GPU ring always reports its capacity,
 * so GPU slots wait the lifetime bound; CPU slots (the Basic fallback and every Particle Graph)
 * count live particles. A system stopped before it started (paused) never emitted.
 */
const slotsDrained = (records: readonly SlotRecord[]): boolean => records.every((record) => !record.started ||
  (record.kind === "basic" && record.gpu
    ? record.system.getActiveCount() === 0 || record.drainedTime > record.lifetime
    : record.system.getActiveCount() === 0));
const liveKey = (actorGuid: string, componentId: string): string => `${actorGuid}:${componentId}`;
const TIER_ORDER: readonly ParticleEmitterChangeTier[] = ["none", "live", "respawn", "rebuild"];
const maxTier = (a: ParticleEmitterChangeTier, b: ParticleEmitterChangeTier): ParticleEmitterChangeTier =>
  TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
const sameContent = (a: unknown, b: unknown): boolean => stableStringify(a ?? null) === stableStringify(b ?? null);
const NO_CHANGE: LibraryChange = { tier: "none", bundle: false };
/** The actor of the systems Play's load prepares for its starting-state draw (`prepareSpawnableSystems`). */
const WARM_ACTOR = "particle-service:spawnable";

/**
 * Whether every program `system` draws with (its render Effects, a GPU system's update Effect too) has drawn on
 * `engine`; true where draws are not tracked (WebGPU) or the system holds none yet.
 */
function particleProgramsDrawn(engine: AbstractEngine, system: IParticleSystem): boolean {
  for (const effect of particlePrograms(system)) if (effectDrawnOn(engine, effect) === false) return false;
  return true;
}

/** The programs `system` draws with: its render Effects (per pass and blend mode), and a GPU system's update Effect. */
function particlePrograms(system: IParticleSystem): Set<Effect> {
  const internals = system as unknown as { _drawWrappers?: ({ effect?: Effect | null } | undefined)[][]; _platform?: { _updateEffect?: Effect } };
  const effects = new Set<Effect>();
  for (const wrappers of internals._drawWrappers ?? []) for (const wrapper of wrappers ?? []) if (wrapper?.effect) effects.add(wrapper.effect);
  if (internals._platform?._updateEffect) effects.add(internals._platform._updateEffect);
  return effects;
}
const BUNDLE_REBUILD: LibraryChange = { tier: "rebuild", bundle: true };

/** Main-thread owner. Each component incarnation and preparation generation owns its callbacks and native bundle. */
export class ParticleService {
  private readonly ownerId = ++nextServiceId;
  private readonly scene: Scene;
  private readonly gpuRequested: boolean;
  private readonly statsScope: "global" | "local";
  private readonly acquireMaterial?: (guid: string, owner: ParticleMaterialOwner) => ResourceLease<NodeMaterial> | null;
  private readonly acquireTexture?: (guid: string) => ResourceLease<BaseTexture> | null;
  private readonly acquireModelGeometry?: (guid: string) => Promise<ParticleMeshGeometry | null> | null;
  /** Mesh Shape Model geometry by guid, loaded once per service; null while it loads or when it failed. */
  private readonly modelGeometries = new Map<string, { geometry: ParticleMeshGeometry | null }>();
  /** Noise Texture pixels by guid, read back once per service; null while the read-back runs. */
  private readonly noiseTextures = new Map<string, { pixels: ParticleNoisePixels | null; fallback: boolean; cancel: () => void }>();
  private readonly resolveEmitter?: (slotId: number) => AbstractMesh | null;
  private sceneForSlot?: (slotId: number) => Scene | null;
  private readonly onDiagnostic?: (diagnostic: ParticleServiceDiagnostic) => void;
  private readonly onPlaybackEnded?: (report: ParticlePlaybackEndedReport) => void;
  private readonly sortingLayers?: () => readonly string[] | undefined;
  private library: ParticleLibrary = emptyLibrary();
  private readonly live = new Map<string, LiveComponent>();
  private readonly slotMeshes = new Map<number, AbstractMesh | null>();
  private generation = 0;
  /** Distinguishes Material leases taken for one slot after its preparation (rebuild, rebind). */
  private leaseSerial = 0;
  private paused = false;
  /** Simulation time scale (slomo, `setSimulationTimeScale`); 0 halts like pause without pausing. */
  private timeScale = 1;
  private disposed = false;
  private readonly cancelSceneDispose: () => void;
  /** Whether a system's programs have drawn on the Engine (`effectDrawnOn`; true where draws are not tracked). */
  private readonly programsDrawn: (system: IParticleSystem) => boolean;
  /** This frame's first-draw budget for systems whose programs never drew, and the entries waiting for one. */
  private firstDrawBudget: number = FIRST_DRAWS_PER_FRAME.webgl2;
  private readonly waitingToStart = new Set<LiveComponent>();
  /** Programs of the systems the load prepared for its starting-state draw, kept compiled (`releaseSpawnableSystems`). */
  private readonly retainedPrograms: Effect[] = [];
  /** Systems a starting-state draw drew unstarted (`drawingUnstartedSystems`). */
  private readonly drawnUnstarted = new WeakSet<IParticleSystem>();

  constructor(options: {
    scene: Scene;
    gpuSupported?: boolean;
    /** A null lease skips the slot with `particle.missing_material`. */
    acquireMaterial?: (guid: string, owner: ParticleMaterialOwner) => ResourceLease<NodeMaterial> | null;
    resolveEmitter?: (slotId: number) => AbstractMesh | null;
    /** A null result means that the intended owner is not available yet. */
    sceneForSlot?: (slotId: number) => Scene | null;
    onDiagnostic?: (diagnostic: ParticleServiceDiagnostic) => void;
    /**
     * A playing component stopped: its drain completed (a finished Once system or Stop) or its
     * bundle has no playable slot. Never for previews, Play's load warm-up, or retire/despawn.
     */
    onPlaybackEnded?: (report: ParticlePlaybackEndedReport) => void;
    /** The project's ordered sorting layers, read when a system is built; `DEFAULT_SORTING_LAYERS` when unset. */
    sortingLayers?: () => readonly string[] | undefined;
    /** "global" (Play, player) publishes `particleStats`; "local" (previews) only serves `stats()`. */
    statsScope?: "global" | "local";
    /** Whether a system's programs have drawn on the Engine; defaults to the Engine's tracked draws. */
    programsDrawn?: (system: IParticleSystem) => boolean;
    /** A Noise node's Texture, read back once; without it (or for a missing Texture) Noise uses the built-in noise. */
    acquireTexture?: (guid: string) => ResourceLease<BaseTexture> | null;
    /** A Mesh Shape Model's triangles in model space (null: unavailable). */
    acquireModelGeometry?: (guid: string) => Promise<ParticleMeshGeometry | null> | null;
  }) {
    this.scene = options.scene;
    this.gpuRequested = options.gpuSupported ?? true;
    this.statsScope = options.statsScope ?? "global";
    this.acquireMaterial = options.acquireMaterial;
    this.acquireTexture = options.acquireTexture;
    this.acquireModelGeometry = options.acquireModelGeometry;
    this.resolveEmitter = options.resolveEmitter;
    this.sceneForSlot = options.sceneForSlot;
    this.onDiagnostic = options.onDiagnostic;
    this.onPlaybackEnded = options.onPlaybackEnded;
    this.sortingLayers = options.sortingLayers;
    const engine = this.scene.getEngine();
    this.programsDrawn = options.programsDrawn ?? ((system) => particleProgramsDrawn(engine, system));
    const observer = this.scene.onDisposeObservable.addOnce(() => this.dispose());
    const frames = this.scene.onBeforeRenderObservable.add(() => this.startWaitingSystems());
    this.cancelSceneDispose = () => {
      this.scene.onDisposeObservable.remove(observer);
      this.scene.onBeforeRenderObservable.remove(frames);
    };
    this.publishStats();
  }

  /** Play: replaces the library for later preparations and leaves running bundles alone. */
  setLibrary(library: ParticleLibrary): void { this.library = library; }
  setSceneForSlot(resolver: ((slotId: number) => Scene | null) | undefined): void {
    this.sceneForSlot = resolver;
    for (const entry of this.live.values()) this.refreshOwner(entry);
  }

  /**
   * Preview: hot-applies a changed library to prepared bundles. Value edits apply in
   * place and keep particles, define-changing edits restart GPU particles, and the rest
   * (or any change to a skipped slot's source) re-prepare the bundle with its play state.
   * A Particle Graph whose compile key changes rebuilds only its own slot; a Material
   * change rebinds its running system. Draining and released bundles pick the change up
   * on their next Play.
   */
  updateLibrary(library: ParticleLibrary): { tier: ParticleEmitterChangeTier } {
    this.library = library;
    let applied: ParticleEmitterChangeTier = "none";
    for (const entry of [...this.live.values()]) {
      if (this.disposed || this.live.get(entry.key) !== entry) continue;
      const change = this.changeTier(entry, library);
      if (change.tier === "none") continue;
      applied = maxTier(applied, change.tier);
      if (change.bundle) {
        this.releaseBundle(entry);
        this.prepare(entry);
      } else this.applyInPlace(entry);
    }
    this.publishStats();
    return { tier: applied };
  }

  /**
   * The tier `updateLibrary(library)` would apply now, without applying it. Only the
   * service knows skipped slots, so a value edit that re-prepares one reads `rebuild`.
   */
  libraryChangeTier(library: ParticleLibrary): ParticleEmitterChangeTier {
    let tier: ParticleEmitterChangeTier = "none";
    for (const entry of this.live.values()) tier = maxTier(tier, this.changeTier(entry, library).tier);
    return tier;
  }

  /** Null when the component has no entry (never assigned, cleared, or an unknown System). */
  playbackState(actorGuid: string, componentId: string): ParticlePlaybackState | null {
    const state = this.live.get(liveKey(actorGuid, componentId))?.state;
    return state && state !== "retired" ? state : null;
  }

  /** Instance-scoped loading readiness; other streams cannot hold this batch. */
  pendingSlotPreparation(slots: ReadonlySet<number>): string[] {
    const pending: string[] = [];
    for (const entry of this.live.values()) {
      if (!slots.has(entry.command.slotId)) continue;
      if (entry.preparationFailed)
        throw new Error(`Streamed particle component ${entry.key} failed to load.`);
      if (entry.state === "preparing" || entry.systems.some((record) => !record.system.isReady()))
        pending.push(`particle ${entry.key}`);
    }
    return pending;
  }

  startPreparedSlots(slots: readonly number[]): void {
    const ready = new Set(slots);
    for (const entry of this.live.values()) if (ready.has(entry.command.slotId) && entry.state === "playing") this.startSystems(entry);
  }

  bindSlot(slotId: number, mesh: AbstractMesh | null): void {
    this.slotMeshes.set(slotId, mesh);
    for (const entry of this.live.values()) {
      if (entry.command.slotId !== slotId) continue;
      this.refreshOwner(entry);
      if (entry.node) entry.node.parent = mesh?.getScene() === entry.scene ? mesh : null;
      for (const ghost of entry.ghosts) if (ghost.node) ghost.node.parent = mesh?.getScene() === ghost.node.getScene() ? mesh : null;
    }
  }

  retireSlots(matches: (slotId: number) => boolean): void {
    for (const entry of this.live.values()) if (matches(entry.command.slotId)) this.retire(entry);
    for (const slot of this.slotMeshes.keys()) if (matches(slot)) this.slotMeshes.delete(slot);
    this.publishStats();
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.updateHalt(() => { this.paused = paused; });
  }

  /**
   * Slomo: every system simulates at its authored speed × `scale`, so emission clocks, burst
   * schedules, drain timers and graph Time / Delta Time follow. 0 holds the systems like pause,
   * but a later scale resumes them whatever the pause state was.
   */
  setTimeScale(scale: number): void {
    const next = Number.isFinite(scale) ? Math.max(0, scale) : 1;
    if (next === this.timeScale) return;
    this.updateHalt(() => { this.timeScale = next; });
  }

  /** Paused, or time scale 0: systems hold still and wait to start. */
  private get halted(): boolean {
    return this.paused || this.timeScale === 0;
  }

  private updateHalt(change: () => void): void {
    const wasHalted = this.halted;
    change();
    for (const entry of this.live.values()) for (const record of allRecords(entry)) this.applySpeed(record);
    if (this.halted || !wasHalted) return;
    // Speeds and the graph flag are restored first: CPU prewarm runs inside `start()`
    // (and skips a paused system), GPU prewarm on the first render.
    for (const entry of [...this.live.values()]) if (entry.state === "playing") this.startSystems(entry);
    this.publishStats();
  }

  /**
   * Writes the live speed: 0 while halted, else the authored speed × the time scale. A GPU
   * system keeps its authored speed until its prewarm render, so Pre Warm simulates its
   * authored seconds. Zero speed still consumes manual emissions and Node Update blocks, so
   * halted systems are also `paused` (CPU and repository-patched GPU owners skip their
   * simulation at that gate).
   */
  private applySpeed(record: SlotRecord): void {
    const halted = this.halted;
    const scale = record.kind === "basic" && record.prewarmPending ? 1 : this.timeScale;
    record.system.updateSpeed = halted ? 0 : record.updateSpeed * scale;
    (record.system as ParticleSystem | GPUParticleSystem).paused = halted;
  }

  handleCommand(command: CommandMessage): void {
    if (this.disposed) return;
    if (command.type === "despawn" || command.type === "spawn") this.retireSlots((slot) => slot === command.slotId);
    else if (command.type === "assignParticle") this.assign(command);
    else if (command.type === "setSimulationTimeScale") this.setTimeScale(command.scale);
    else if (command.type === "emitParticleBurst") this.burst(command);
    else if (command.type === "setParticlePlaying") {
      for (const entry of [...this.live.values()]) {
        if (entry.command.actorGuid !== command.actorGuid || (command.componentId && entry.command.componentId !== command.componentId)) continue;
        if (this.live.get(entry.key) !== entry) continue;
        // A Play on a playing entry is idempotent but still names the generation its end reports.
        if (command.playing && command.generation !== undefined) entry.playGeneration = command.generation;
        if (command.playing) this.play(entry, command.restart === true ? "restart" : entry.command.retrigger ?? "overlap", command.restart === true);
        else this.stop(entry);
      }
      this.publishStats();
    }
  }

  /**
   * Emit Particle Burst: `count` more particles from each matching slot of a playing bundle
   * (every slot, or the one at `slot`), capped at the slot's running capacity and emitted one
   * frame late like an authored burst. A component that is not playing ignores it with a
   * debug-level note: bursts never start systems.
   */
  private burst(command: Extract<CommandMessage, { type: "emitParticleBurst" }>): void {
    const count = Math.floor(command.count);
    if (!(count > 0)) return;
    const slot = command.slot === undefined || command.slot < 0 ? null : Math.floor(command.slot);
    let playing = false;
    for (const entry of this.live.values()) {
      if (entry.warm || entry.command.actorGuid !== command.actorGuid || (command.componentId && entry.command.componentId !== command.componentId)) continue;
      if (entry.state !== "playing") continue;
      playing = true;
      for (const record of entry.systems) {
        if (record.stopped || (slot !== null && record.index !== slot)) continue;
        const capped = Math.min(count, record.system.getCapacity());
        if (record.kind === "basic") record.driver.burst(capped);
        else record.requestedBurst += capped;
      }
    }
    if (!playing && this.statsScope === "global") {
      this.onDiagnostic?.({ code: "particle.burst_not_playing", severity: "verbose",
        message: "Emit Particle Burst skipped: the particle component is not playing." });
    }
  }

  stats(): ParticleStats {
    let systems = 0;
    let playing = 0;
    let gpuSystems = 0;
    let graphSystems = 0;
    for (const entry of this.live.values()) {
      if (entry.warm) continue;
      const records = allRecords(entry);
      systems += records.length;
      for (const record of records) {
        if (record.gpu) gpuSystems += 1;
        if (record.kind === "graph") graphSystems += 1;
      }
      if (entry.desiredPlaying && (entry.state === "preparing" || entry.state === "playing")) playing += 1;
    }
    const gpu = gpuSystems > 0 || gpuParticlesSupported(this.scene.getEngine(), this.gpuRequested);
    return { systems, playing, gpu, gpuSystems, graphSystems };
  }

  /** Preview badges: CPU live counts (Basic fallback and every Particle Graph) plus GPU claimed rings (approximate). */
  previewStats(): ParticlePreviewStats {
    let active = 0;
    let capacity = 0;
    let gpu = 0;
    let cpu = 0;
    for (const entry of this.live.values()) for (const record of allRecords(entry)) {
      active += record.system.getActiveCount();
      capacity += record.system.getCapacity();
      if (record.gpu) gpu += 1;
      else cpu += 1;
    }
    const backend = gpu && cpu ? "mixed" : gpu ? "gpu" : cpu ? "cpu" : "none";
    return { active, capacity, backend, approximate: gpu > 0 };
  }

  /**
   * Preview: whether the Scene must keep rendering for this service. Systems only advance
   * inside a Scene render, so a bundle that is still preparing, emitting or draining needs
   * frames, while a paused service, a finished Once run (`ready-stopped`) and a failed
   * bundle hold a picture that no further render changes. The live particle count cannot
   * decide this: a freshly started or slow emitter reports zero until its next render.
   */
  needsFrames(): boolean {
    if (this.halted || this.disposed) return false;
    for (const entry of this.live.values()) {
      if (entry.state === "preparing" || entry.state === "playing" || entry.state === "draining" || entry.ghosts.length) return true;
    }
    return false;
  }

  /** Play's load: whether a component is to play, so the starting-state draw has particle programs to draw. */
  holdsPlayingComponents(): boolean {
    for (const entry of this.live.values()) if (entry.desiredPlaying || entry.warm) return true;
    return false;
  }

  /**
   * Play's load: prepares each system of the library (the load's) that no component plays, the ones a spawn may, on
   * an emitter of its own at the origin, unstarted, so the starting-state draw draws its programs
   * (`drawingUnstartedSystems`) and a spawn first-draws none of them. Its diagnostics wait for a component that plays
   * it. `releaseSpawnableSystems` retires them once that draw is done.
   */
  prepareSpawnableSystems(): void {
    this.releaseSpawnableSystems();
    this.releaseRetainedPrograms();
    const played = new Set<string>();
    for (const entry of this.live.values()) if (entry.command.particleSystemGuid) played.add(entry.command.particleSystemGuid);
    let slotId = -1;
    for (const guid of this.library.systems.keys()) {
      if (played.has(guid)) continue;
      const command: Assignment = { type: "assignParticle", slotId: slotId--, actorGuid: WARM_ACTOR, componentId: guid, particleSystemGuid: guid, play: true };
      const entry: LiveComponent = { key: liveKey(WARM_ACTOR, guid), command, desiredPlaying: true, playGeneration: 0, state: "preparing", generation: 0,
        scene: null, node: null, systems: [], ghosts: [], source: null, cancel: [], building: false, warm: true };
      this.live.set(entry.key, entry);
      this.prepare(entry);
    }
    this.publishStats();
  }

  /** Whether a system `prepareSpawnableSystems` prepared is still preparing. */
  spawnableSystemsPending(): boolean {
    for (const entry of this.live.values()) {
      if (!entry.warm || entry.state === "failed") continue;
      if (entry.state === "preparing" || entry.systems.some((record) => record.pending || !record.system.isReady())) return true;
    }
    return false;
  }

  /**
   * Whether a system `prepareSpawnableSystems` prepared is ready but no starting-state draw has drawn it: one that became
   * ready after its first draw, which only a further draw of it completes.
   */
  spawnableSystemsUndrawn(): boolean {
    for (const entry of this.live.values()) {
      if (!entry.warm || entry.state === "failed") continue;
      if (entry.systems.some((record) => !record.pending && record.system.isReady() && !this.drawnUnstarted.has(record.system))) return true;
    }
    return false;
  }

  /**
   * Retires the systems `prepareSpawnableSystems` prepared, keeping their programs compiled (one reference each) until
   * the next load's or the session's end, as the starting state's Effects are: a spawn then neither compiles nor
   * first-draws them.
   */
  releaseSpawnableSystems(): void {
    for (const entry of [...this.live.values()]) {
      if (!entry.warm) continue;
      for (const record of entry.systems) for (const effect of particlePrograms(record.system)) {
        effect._refCount += 1;
        this.retainedPrograms.push(effect);
      }
      this.retire(entry);
    }
  }

  private releaseRetainedPrograms(): void {
    for (const effect of this.retainedPrograms.splice(0)) effect.dispose();
  }

  /**
   * Play's starting-state draw (behind its loading screen): runs `draw` with every prepared system that has not
   * started drawing too, so each draws its programs (a GPU system's update and render, a CPU system's render) before
   * gameplay does. A program's first draw holds iPad WebKit WebGL2 (`first-draw-stats.ts`), and the systems start only
   * once the load ends, all in the same frame. Each draws at zero speed, emitting nothing (a CPU system one particle,
   * as it draws only live ones), and is reset afterwards, unstarted: gameplay starts, prewarms and emits as before.
   */
  drawingUnstartedSystems<T>(draw: () => T): T {
    const warmed: Array<{ system: ParticleSystem | GPUParticleSystem; speed: number; paused: boolean; prewarm: number; emit: number }> = [];
    for (const entry of this.live.values()) for (const record of entry.systems) {
      const system = record.system as ParticleSystem | GPUParticleSystem;
      if (record.started || record.pending || system.isStarted() || !system.isReady()) continue;
      warmed.push({ system, speed: system.updateSpeed, paused: system.paused, prewarm: system.preWarmCycles, emit: system.manualEmitCount });
      this.drawnUnstarted.add(system);
      system.updateSpeed = 0;
      system.paused = false;
      system.preWarmCycles = 0;
      (system as unknown as { _started: boolean })._started = true;
      if (!record.gpu) {
        system.manualEmitCount = 1;
        system.animate();
      }
    }
    try {
      return draw();
    } finally {
      for (const { system, speed, paused, prewarm, emit } of warmed) {
        system.reset();
        (system as unknown as { _started: boolean })._started = false;
        system.manualEmitCount = emit;
        system.updateSpeed = speed;
        system.paused = paused;
        system.preWarmCycles = prewarm;
      }
    }
  }

  resetSession(): void {
    for (const entry of this.live.values()) this.retire(entry);
    this.timeScale = 1;
    this.releaseRetainedPrograms();
    this.slotMeshes.clear();
    this.publishStats();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelSceneDispose();
    this.resetSession();
    this.library = emptyLibrary();
    for (const texture of this.noiseTextures.values()) texture.cancel();
    this.noiseTextures.clear();
    this.modelGeometries.clear();
  }

  /**
   * A Mesh Shape's geometry. Model: the Model's triangles, loaded once per service. Owner Mesh:
   * the owning actor's first mesh with vertices, found (at most once a frame) the first time it is
   * there and kept in the emitter's space; previews, which have no actor, use a unit sphere.
   * Without geometry particles spawn at the emitter; `particle.mesh_missing` reports a Model that
   * cannot load at once, and an owner without a mesh after two seconds of frames.
   */
  private meshShapeSource(entry: LiveComponent, context: SlotContext, properties: Readonly<Record<string, unknown>>): ParticleMeshShapeSource {
    if (properties.source === "model") {
      const guid = typeof properties.modelGuid === "string" && properties.modelGuid ? properties.modelGuid : null;
      if (!guid) return { geometry: () => null };
      let record = this.modelGeometries.get(guid);
      if (!record) {
        const created: { geometry: ParticleMeshGeometry | null } = { geometry: null };
        record = created;
        this.modelGeometries.set(guid, created);
        const missing = () => this.diagnose(entry, { code: "particle.mesh_missing", assetGuid: guid,
          message: "Mesh Shape Model has no geometry to spawn on; particles spawn at the emitter." });
        const pending = this.acquireModelGeometry?.(guid) ?? null;
        if (!pending) missing();
        else void pending.then((geometry) => {
          if (geometry && geometry.indices.length >= 3) created.geometry = geometry;
          else missing();
        }, missing);
      }
      const loaded = record;
      return { geometry: () => loaded.geometry };
    }
    if (!this.resolveEmitter) return PREVIEW_OWNER_MESH;
    let geometry: ParticleMeshGeometry | null = null;
    let lastFrame = -1;
    let firstFrame = -1;
    let reported = false;
    return {
      geometry: () => {
        if (geometry) return geometry;
        const frame = context.host.getFrameId();
        if (frame === lastFrame) return null;
        lastFrame = frame;
        if (firstFrame < 0) firstFrame = frame;
        const root = this.resolveEmitter?.(entry.command.slotId) ?? null;
        const mesh = root ? [root, ...root.getChildMeshes(false)].find((candidate): candidate is Mesh =>
          candidate instanceof Mesh && candidate !== context.node && !candidate.isDisposed() && candidate.getTotalVertices() > 0) : undefined;
        if (mesh) geometry = meshGeometryRelativeTo(mesh, context.node);
        if (!geometry && !reported && frame - firstFrame > 120) {
          reported = true;
          this.diagnose(entry, { code: "particle.mesh_missing", assetGuid: entry.command.particleSystemGuid ?? undefined,
            message: "Mesh Shape found no mesh on its actor; particles spawn at the emitter." });
        }
        return geometry;
      },
    };
  }

  /**
   * A Noise node's pixels: the built-in noise without a Texture; otherwise the Texture's pixels,
   * read back once and shared by every system of this service (none until then). A Texture that
   * cannot be acquired or read falls back to the built-in noise with `particle.noise_texture_unavailable`.
   */
  private noiseSource(entry: LiveComponent, textureGuid: string | null): ParticleNoiseSource {
    if (!textureGuid) return BUILTIN_PARTICLE_NOISE;
    let texture = this.noiseTextures.get(textureGuid);
    if (!texture) {
      const record: { pixels: ParticleNoisePixels | null; fallback: boolean; cancel: () => void } = { pixels: null, fallback: false, cancel: () => {} };
      texture = record;
      this.noiseTextures.set(textureGuid, record);
      const unavailable = (reason: string) => {
        record.fallback = true;
        this.diagnose(entry, { code: "particle.noise_texture_unavailable", assetGuid: textureGuid,
          message: `Noise Texture ${reason}; the built-in noise is used.` });
      };
      const lease = this.acquireTexture?.(textureGuid) ?? null;
      if (!lease) unavailable("is missing");
      else {
        let released = false;
        const release = () => { if (!released) { released = true; lease.release(); } };
        record.cancel = release;
        void (lease.ready ?? Promise.resolve())
          .then(() => (released ? null : lease.resource.readPixels()))
          .then((view) => {
            if (released) return;
            const pixels = view ? particleNoisePixelsFrom(view, lease.resource.getSize()) : null;
            if (pixels) record.pixels = pixels;
            else unavailable("could not be read");
          }, () => { if (!released) unavailable("could not be read"); })
          .finally(release);
      }
    }
    const record = texture;
    return { pixels: () => (record.fallback ? BUILTIN_PARTICLE_NOISE.pixels() : record.pixels) };
  }

  private assign(command: Assignment): void {
    const key = liveKey(command.actorGuid, command.componentId);
    const previous = this.live.get(key);
    if (previous) this.retire(previous);
    const guid = command.particleSystemGuid?.trim();
    if (!guid) { this.publishStats(); return; }
    if (!this.library.systems.has(guid)) {
      this.onDiagnostic?.({ code: "particle.unknown_system", message: "Particle System asset is missing; playback skipped.", assetGuid: guid });
      this.publishStats();
      if (command.play !== false) this.report(command, command.generation ?? 0, "failed");
      return;
    }
    // Desired state is published before any native or material callback can run.
    const entry: LiveComponent = { key, command: { ...command, particleSystemGuid: guid }, desiredPlaying: command.play !== false,
      playGeneration: command.generation ?? 0, state: "preparing", generation: 0, scene: null, node: null, systems: [], ghosts: [],
      source: null, cancel: [], building: false };
    this.live.set(key, entry);
    this.prepare(entry);
    this.publishStats();
  }

  private hostFor(entry: LiveComponent): Scene | null {
    if (entry.warm) return this.scene;
    return this.sceneForSlot ? this.sceneForSlot(entry.command.slotId) : this.scene;
  }

  /** A warm entry's problems are reported when a component plays its system, not at the load. */
  private diagnose(entry: LiveComponent, diagnostic: ParticleServiceDiagnostic): void {
    if (!entry.warm) this.onDiagnostic?.(diagnostic);
  }

  private current(entry: LiveComponent, generation: number): boolean {
    return !this.disposed && this.live.get(entry.key) === entry && entry.generation === generation &&
      entry.state !== "retired" && !entry.scene?.isDisposed && this.hostFor(entry) === entry.scene;
  }

  private refreshOwner(entry: LiveComponent): void {
    const host = this.hostFor(entry);
    if (host === entry.scene && entry.node) return;
    if (host !== entry.scene) this.disposeGhosts(entry);
    this.releaseBundle(entry);
    this.prepare(entry);
  }

  private slotContext(entry: LiveComponent, host: Scene, node: Mesh, space: ParticleSpace): SlotContext {
    return {
      host, node, space, generation: entry.generation,
      sorting: resolveSortingLayer(this.sortingLayers?.() ?? DEFAULT_SORTING_LAYERS, entry.command.sortingLayer?.trim() || "Default", entry.command.orderInLayer ?? 0),
      // The owning engine decides, not the last-created one.
      backend: particleSimBackend(host.getEngine(), this.gpuRequested),
    };
  }

  private prepare(entry: LiveComponent): void {
    const host = this.hostFor(entry);
    entry.state = "preparing";
    entry.preparationFailed = false;
    if (!host || host.isDisposed) return;
    const payload = this.library.systems.get(entry.command.particleSystemGuid!) ?? null;
    const source: BundleSource = { system: payload, emitters: new Map(), skipped: new Set() };
    entry.source = source;
    if (!payload) { entry.preparationFailed = true; entry.state = "failed"; this.reportFailed(entry); return; }
    entry.scene = host;
    entry.generation = ++this.generation;
    entry.building = true;
    const generation = entry.generation;
    try {
      // A particle system draws only while its emitter survives FrameGraph culling, which drops
      // `visibility = 0` meshes. A geometry-less Mesh stays visible, is always ready and draws nothing;
      // `alwaysSelectAsActiveMesh` keeps it past the frustum test while only its particles are on screen.
      const node = new Mesh(`particleEmitter:${entry.key}`, host);
      entry.node = node;
      node.isPickable = false; drawWhateverTheView(node);
      const parent = this.slotMeshes.get(entry.command.slotId) ?? this.resolveEmitter?.(entry.command.slotId);
      if (parent?.getScene() === host) node.parent = parent;
      const context = this.slotContext(entry, host, node, payload.space);
      for (const [index, guid] of payload.emitterGuids.entries()) {
        const emitter = this.library.emitters.get(guid);
        source.emitters.set(guid, emitter);
        if (!emitter) {
          this.diagnose(entry, { code: "particle.unknown_emitter", message: "Particle Emitter asset is missing; slot skipped.", assetGuid: guid });
          source.skipped.add(guid);
          continue;
        }
        const record = this.prepareSlot(entry, context, { index, guid, emitter });
        if (record) entry.systems.push(record);
        else source.skipped.add(guid);
      }
      // No playable slot: behave as an empty bundle without native systems.
      if (!entry.systems.length) { this.releaseBundle(entry); entry.state = "failed"; this.reportFailed(entry); return; }
      const disposing = host.onDisposeObservable.addOnce(() => this.retire(entry));
      const before = host.onBeforeRenderObservable.add(() => {
        if (!this.current(entry, generation)) return;
        try {
          for (const record of entry.systems) {
            if (record.kind === "basic" && record.gpu) record.lifetime = Math.max(record.lifetime, particleLifetimeBound(record.system));
          }
        } catch (error) { this.fail(entry, generation, error); }
      });
      const after = host.onAfterRenderObservable.add(() => {
        if (!this.current(entry, generation)) return;
        if (entry.state === "playing" && !this.halted) {
          // The driver runs on the simulation clock, so pause (updateSpeed 0) holds it.
          const ratio = host.getAnimationRatio() || 1;
          for (const record of entry.systems) {
            if (record.stopped) continue;
            const dt = record.system.updateSpeed * ratio;
            if (record.kind === "basic") {
              if (!record.prewarmPending) record.driver.advance(dt);
              continue;
            }
            record.manual.restore();
            if (record.requestedBurst > 0 && dt > 0) {
              record.manual.queue(record.requestedBurst, dt);
              record.requestedBurst = 0;
            }
          }
        }
        this.finishDrain(entry, generation);
      });
      entry.cancel.push(() => host.onDisposeObservable.remove(disposing), () => host.onBeforeRenderObservable.remove(before), () => host.onAfterRenderObservable.remove(after));
      entry.building = false;
      if (entry.systems.some((record) => record.pending)) {
        const readiness = { isReady: () => isSceneStreamSlotPending(host, entry.command.slotId) };
        host.addIsReadyCheck(readiness);
        markSceneReadinessDirty(host);
        entry.preparationCheck = () => {
          host.removeIsReadyCheck(readiness);
          markSceneReadinessDirty(host);
        };
        entry.stopBound = boundParticlePreparation(host.getEngine(), () => {
          const waiting = entry.systems.filter((record) => record.pending).length;
          return `Particle preparation timed out (slots not ready: ${waiting} of ${entry.systems.length}).`;
        }, (error) => this.fail(entry, generation, error));
      }
      this.startIfReady(entry);
    } catch (error) { this.fail(entry, generation, error); }
  }

  /** Library documents are replaced, never mutated, so the document object keys its plan. */
  private planFor(document: ParticleGraphDocument): ParticleGraphLowerResult {
    return lowerParticleGraphDocumentCached(document);
  }

  private graphCompileKey(document: ParticleGraphDocument): string {
    const lowered = this.planFor(document);
    return lowered.ok ? lowered.plan.hash : particleGraphCompileKey(document);
  }

  /**
   * Every per-slot failure skips only that slot; the bundle keeps its other slots. The
   * caller adds the returned record to the bundle. `rekey` gives a slot prepared again
   * inside a running bundle its own Material lease.
   */
  private prepareSlot(entry: LiveComponent, context: SlotContext, slot: {
    index: number; guid: string; emitter: ParticleLibraryEmitter; rekey?: boolean;
  }): SlotRecord | null {
    const { host, generation } = context;
    const { guid, emitter } = slot;
    const label = emitter.kind === "graph" ? "Particle Graph" : "Particle Emitter";
    const materialGuid = particleEmitterMaterialGuid(emitter);
    if (!materialGuid) {
      this.diagnose(entry, { code: "particle.missing_material", assetGuid: guid, message: `${label} has no Material; slot skipped.` });
      return null;
    }
    let plan: ParticleBuildPlan | null = null;
    if (emitter.kind === "graph") {
      const lowered = this.planFor(emitter.document);
      if (!lowered.ok) {
        const errors = lowered.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
        const first = errors[0];
        this.diagnose(entry, { code: "particle.graph_invalid", assetGuid: guid,
          message: `Particle Graph has ${errors.length} ${errors.length === 1 ? "error" : "errors"}; slot skipped.${first ? ` ${first.message}` : ""}`,
          ...(first?.nodeId ? { nodeId: first.nodeId } : {}), ...(first?.pinId ? { pinId: first.pinId } : {}) });
        return null;
      }
      plan = lowered.plan;
    }
    const instanceKey = `particle:${this.ownerId}:${entry.key}:${generation}:${slot.index}${slot.rekey ? `:${++this.leaseSerial}` : ""}`;
    const lease = this.acquireMaterial?.(materialGuid, { scene: host, instanceKey }) ?? null;
    if (!lease) {
      this.diagnose(entry, { code: "particle.missing_material", assetGuid: guid,
        message: `${label} has no usable Material (missing, or not in the Particle domain); slot skipped.` });
      return null;
    }
    let record: SlotRecord | null = null;
    try {
      const created = plan
        ? this.createGraphSlot(entry, context, slot, plan, lease, materialGuid)
        : emitter.kind === "basic" ? this.createBasicSlot(entry, context, slot, emitter.payload, lease) : null;
      if (!created) {
        // Graph build diagnostics were reported by `createGraphSlot`.
        lease.release();
        return null;
      }
      record = created.record;
      const system = record.system;
      registerSceneStreamParticle(system, entry.command.slotId);
      const ready = bindParticleMaterial(system, lease.resource);
      this.applySpeed(record);
      applySortingToParticleSystem(system, context.sorting);
      const owned = record;
      const stopped = system.onStoppedObservable.add(() => {
        // Babylon notifies before setting its own stopped flag; a drain marks records first.
        if (!this.current(entry, generation) || owned.stopped) return;
        owned.stopped = true;
        if (owned.kind === "basic") owned.driver.halt();
        if (entry.state === "playing" && entry.systems.every((other) => other.stopped)) this.beginDrain(entry, "finished");
      });
      record.cancel.push(() => system.onStoppedObservable.remove(stopped));
      if (record.kind === "basic" && record.gpu) {
        const basic = record;
        const draw = system.onBeforeDrawParticlesObservable.add(() => {
          if (!this.current(entry, generation)) return;
          // Babylon draws only after its prewarm, so bursts queued from now on are rendered.
          if (basic.prewarmPending) {
            basic.prewarmPending = false;
            this.applySpeed(basic);
          }
          // The system steps once per scene frame, on its first draw (MULTIPLYADD
          // draws twice, and Render Target Captures draw in the same frame).
          const frame = host.getFrameId();
          if (basic.lastFrame === frame) return;
          basic.lastFrame = frame;
          if (basic.stopped) basic.drainedTime += particleSimulationDelta(system);
        });
        record.cancel.push(() => system.onBeforeDrawParticlesObservable.remove(draw));
      }
      this.waitFor(entry, record, generation, ready, lease);
      if (lease.ready) this.waitFor(entry, record, generation, lease.ready, lease);
      if (created.buildReady) this.waitFor(entry, record, generation, created.buildReady);
      return record;
    } catch (error) {
      entry.preparationFailed = true;
      if (record) this.disposeSlots([record]);
      lease.release();
      this.diagnose(entry, { code: "particle.apply_failed", assetGuid: guid, message: describeParticleThrow(error) });
      return null;
    }
  }

  private createBasicSlot(entry: LiveComponent, context: SlotContext, slot: { index: number; guid: string },
    payload: ParticleEmitterPayload, lease: ResourceLease<NodeMaterial>): CreatedSlot {
    const plan = resolveBasicEmitterPlan(payload, { backend: context.backend, space: context.space });
    const gpu = context.backend !== "cpu";
    const system = createBabylonParticleSystem(`particle:${entry.key}:${slot.index}`, context.host, plan.capacity, gpu);
    try {
      system.emitter = context.node;
      applyBasicEmitterPlan(system, plan, "create");
      return { record: { kind: "basic", index: slot.index, emitterGuid: slot.guid, system, lease, gpu, backend: context.backend,
        payload, driver: createBasicEmissionDriver(system, plan.schedule), prewarmPending: gpu && plan.preWarmCycles > 0,
        pending: 0, updateSpeed: plan.updateSpeed, started: false, stopped: false, once: payload.emitter.loop === "once",
        lifetime: plan.lifetimeBound, drainedTime: 0, lastFrame: -1, cancel: [] } };
    } catch (error) {
      system.dispose();
      throw error;
    }
  }

  /** Builds synchronously; build problems are reported per graph node and skip only this slot. */
  private createGraphSlot(entry: LiveComponent, context: SlotContext, slot: { index: number; guid: string },
    plan: ParticleBuildPlan, lease: ResourceLease<NodeMaterial>, materialGuid: string): CreatedSlot | null {
    const realized = realizeParticleGraph(plan, { scene: context.host, name: `particle:${entry.key}:${slot.index}`,
      emitter: context.node, space: context.space, noise: (textureGuid) => this.noiseSource(entry, textureGuid),
      meshShape: (properties) => this.meshShapeSource(entry, context, properties) });
    if (realized.ok === false) {
      for (const diagnostic of realized.diagnostics) this.diagnose(entry, { ...diagnostic, assetGuid: slot.guid });
      return null;
    }
    const system = realized.system;
    // Node-built systems compute their rate from the Emit Rate input each frame.
    const rate = (system as unknown as { _calculateEmitRate?: () => number })._calculateEmitRate;
    return {
      record: { kind: "graph", gpu: false, index: slot.index, emitterGuid: slot.guid, system, lease,
        set: realized.set, compileKey: plan.hash, materialGuid, pending: 0, updateSpeed: system.updateSpeed,
        started: false, stopped: false, once: plan.settings.loop === "once", cancel: [],
        manual: createManualEmission(system, () => rate ? rate.call(system) : system.emitRate), requestedBurst: 0 },
      buildReady: realized.buildReady,
    };
  }

  /**
   * Counts one readiness promise on the slot. `lease` names the Material lease the
   * promise belongs to: once a rebind replaced that lease, releasing it cancels its
   * preparation, and that rejection only settles the wait instead of failing the slot.
   */
  private waitFor(entry: LiveComponent, record: SlotRecord, generation: number, ready: Promise<void>,
    lease?: ResourceLease<NodeMaterial>): void {
    record.pending += 1;
    const settle = () => {
      if (!this.current(entry, generation) || !entry.systems.includes(record)) return;
      record.pending -= 1;
      // A slot rebuilt inside a playing bundle starts on its own.
      if (entry.state === "playing") this.startSystems(entry);
      else this.startIfReady(entry);
    };
    void ready.then(settle, (error: unknown) => {
      if (lease && record.lease !== lease) settle();
      else this.failSlot(entry, record, generation, error);
    });
  }

  private startIfReady(entry: LiveComponent): void {
    if (!this.current(entry, entry.generation) || entry.building || !entry.systems.length || entry.systems.some((record) => record.pending)) return;
    if (entry.state !== "preparing" && entry.state !== "ready-stopped") return;
    entry.stopBound?.(); entry.stopBound = undefined;
    entry.preparationCheck?.(); entry.preparationCheck = undefined;
    entry.state = entry.desiredPlaying ? "playing" : "ready-stopped";
    if (entry.desiredPlaying) this.startSystems(entry);
    this.publishStats();
  }

  /**
   * Starts a playing entry's ready systems. While paused they wait for `setPaused(false)`:
   * prewarm at `updateSpeed` 0 would simulate nothing and never run again.
   */
  private startSystems(entry: LiveComponent): void {
    if (entry.warm || this.halted || entry.scene && isSceneStreamSlotPending(entry.scene, entry.command.slotId)) return;
    this.waitingToStart.delete(entry);
    for (const record of entry.systems) {
      // A start observer may Stop or replace the entry.
      if (!this.current(entry, entry.generation) || !entry.desiredPlaying || entry.state !== "playing") break;
      if (record.started || record.pending) continue;
      // A system whose programs no draw on the Engine has used (one Play's load did not know of) starts within the
      // frame's first-draw budget, so several spawned in one frame do not first-draw together (WebGL2).
      if (!this.programsDrawn(record.system)) {
        if (this.firstDrawBudget <= 0) {
          this.waitingToStart.add(entry);
          break;
        }
        this.firstDrawBudget -= 1;
      }
      record.started = true;
      // CPU Pre Warm runs inside `start()`: it simulates the authored seconds, not slowed ones.
      if (this.timeScale !== 1) record.system.updateSpeed = record.updateSpeed;
      record.system.start(0);
      this.applySpeed(record);
    }
  }

  /** Each frame admits `FIRST_DRAWS_PER_FRAME` new systems, then starts the entries that waited, in order. */
  private startWaitingSystems(): void {
    this.firstDrawBudget = FIRST_DRAWS_PER_FRAME.webgl2;
    for (const entry of [...this.waitingToStart]) {
      if (this.live.get(entry.key) !== entry) this.waitingToStart.delete(entry);
      else this.startSystems(entry);
      if (this.firstDrawBudget <= 0) break;
    }
  }

  /**
   * Play. Overlap leaves a draining run, or a playing one whose emitters are all Once, to drain
   * as a ghost while a new run starts; a looping run keeps playing. Restart (the Retrigger, or
   * `force` for Restart Particles) cuts what is on screen, ghosts included, and starts again.
   */
  private play(entry: LiveComponent, retrigger: "overlap" | "restart", force: boolean): void {
    const onScreen = entry.state === "playing" || entry.state === "draining";
    if (force || (retrigger === "restart" && onScreen)) {
      this.disposeGhosts(entry);
      entry.desiredPlaying = true;
      this.releaseBundle(entry);
      this.prepare(entry);
      return;
    }
    if (entry.desiredPlaying) {
      if (entry.state !== "playing" || !entry.systems.length || !entry.systems.every((record) => record.once)) return;
      this.beginDrain(entry, "stopped");
    }
    entry.desiredPlaying = true;
    if (entry.state === "draining") this.ghost(entry);
    if (!entry.node) this.prepare(entry);
    else this.startIfReady(entry);
  }

  /** Detaches the draining bundle as a ghost; the oldest ghost beyond the cap is cut. */
  private ghost(entry: LiveComponent): void {
    const host = entry.scene;
    const node = entry.node;
    const records = entry.systems.splice(0);
    entry.node = null;
    // Cancels the entry's per-bundle observers; nothing native is left in it to dispose.
    this.releaseBundle(entry);
    if (!host || host.isDisposed || !records.length) {
      this.disposeRecords(records, node);
      return;
    }
    const ghost: Ghost = { records, node, cancel: [] };
    for (const record of records) {
      // Observers bound to the bundle's generation are inert now; a GPU slot needs its drain clock.
      for (const cancel of record.cancel.splice(0)) cancel();
      if (record.kind !== "basic" || !record.gpu) continue;
      const basic = record;
      const draw = basic.system.onBeforeDrawParticlesObservable.add(() => {
        const frame = host.getFrameId();
        if (basic.lastFrame === frame) return;
        basic.lastFrame = frame;
        basic.drainedTime += particleSimulationDelta(basic.system);
      });
      basic.cancel.push(() => basic.system.onBeforeDrawParticlesObservable.remove(draw));
    }
    const after = host.onAfterRenderObservable.add(() => { if (slotsDrained(records)) this.disposeGhost(entry, ghost); });
    const disposing = host.onDisposeObservable.addOnce(() => this.disposeGhost(entry, ghost));
    ghost.cancel.push(() => host.onAfterRenderObservable.remove(after), () => host.onDisposeObservable.remove(disposing));
    entry.ghosts.push(ghost);
    while (entry.ghosts.length > PARTICLE_GHOSTS_PER_COMPONENT) this.disposeGhost(entry, entry.ghosts[0]!);
  }

  private disposeGhost(entry: LiveComponent, ghost: Ghost): void {
    const index = entry.ghosts.indexOf(ghost);
    if (index < 0) return;
    entry.ghosts.splice(index, 1);
    for (const cancel of ghost.cancel.splice(0)) cancel();
    this.disposeRecords(ghost.records, ghost.node);
    this.publishStats();
  }

  private disposeGhosts(entry: LiveComponent): void {
    for (const ghost of [...entry.ghosts]) this.disposeGhost(entry, ghost);
  }

  private stop(entry: LiveComponent): void {
    const wasPlaying = entry.desiredPlaying;
    entry.desiredPlaying = false;
    if (entry.state === "preparing" || entry.state === "failed") {
      const failed = entry.state === "failed";
      this.releaseBundle(entry);
      entry.state = "ready-stopped";
      // Stopped before it drew anything: it ends now. A failed bundle already reported.
      if (wasPlaying && !failed) this.report(entry.command, entry.playGeneration, "stopped", entry);
    } else if (entry.state === "playing") this.beginDrain(entry, "stopped");
  }

  /** Stops every emitter that is still running; Once emitters that finished earlier keep their drain time. */
  private beginDrain(entry: LiveComponent, reason: "finished" | "stopped"): void {
    if (this.live.get(entry.key) !== entry || entry.state !== "playing") return;
    entry.desiredPlaying = false;
    entry.endReason = reason;
    entry.state = "draining";
    for (const record of entry.systems) {
      if (record.kind === "basic") record.lifetime = Math.max(record.lifetime, particleLifetimeBound(record.system));
      if (record.stopped) continue;
      if (record.kind === "basic") {
        // Halt first: the driver would otherwise restore rate emission over the mute.
        record.driver.halt();
        record.drainedTime = 0;
      }
      record.stopped = true;
      record.system.manualEmitCount = 0;
      record.system.stop();
    }
    this.publishStats();
  }

  private finishDrain(entry: LiveComponent, generation: number): void {
    if (!this.current(entry, generation) || entry.state !== "draining") return;
    if (!slotsDrained(entry.systems)) return;
    this.releaseBundle(entry);
    entry.state = "ready-stopped";
    this.publishStats();
    this.report(entry.command, entry.playGeneration, entry.endReason ?? "finished", entry);
  }

  /** A bundle that was to play has no playable slot. */
  private reportFailed(entry: LiveComponent): void {
    if (entry.desiredPlaying) this.report(entry.command, entry.playGeneration, "failed", entry);
  }

  /** Previews and Play's load warm-up never report; retire and despawn never call this. */
  private report(command: Assignment, generation: number, reason: ParticlePlaybackEndReason, entry?: LiveComponent): void {
    if (this.statsScope === "local" || entry?.warm || this.disposed || !this.onPlaybackEnded) return;
    this.onPlaybackEnded({ actorGuid: command.actorGuid, componentId: command.componentId, generation, reason });
  }

  /** Bundle-level failure: preparation timeout or a native throw outside one slot. */
  private fail(entry: LiveComponent, generation: number, error: unknown): void {
    if (!this.current(entry, generation)) return;
    entry.preparationFailed = true;
    this.releaseBundle(entry);
    entry.state = "failed";
    this.diagnose(entry, { code: "particle.apply_failed", assetGuid: entry.command.particleSystemGuid ?? undefined,
      message: describeParticleThrow(error) });
    this.publishStats();
    this.reportFailed(entry);
  }

  /** An async Material failure retires only its slot; the other slots may start. */
  private failSlot(entry: LiveComponent, record: SlotRecord, generation: number, error: unknown): void {
    if (!this.current(entry, generation) || !entry.systems.includes(record)) return;
    entry.preparationFailed = true;
    this.removeSlot(entry, record, { code: "particle.apply_failed", assetGuid: record.emitterGuid, message: describeParticleThrow(error) });
    this.publishStats();
  }

  /** Disposes one slot of a live bundle and marks it skipped, so the next edit to its source prepares it again. */
  private removeSlot(entry: LiveComponent, record: SlotRecord, diagnostic?: ParticleServiceDiagnostic): void {
    const index = entry.systems.indexOf(record);
    if (index < 0) return;
    entry.systems.splice(index, 1);
    this.disposeSlots([record]);
    record.lease.release();
    if (diagnostic) this.diagnose(entry, diagnostic);
    this.afterSlotSkipped(entry, record.emitterGuid);
  }

  /** A bundle without its last slot fails; one whose remaining slots all stopped drains. */
  private afterSlotSkipped(entry: LiveComponent, guid: string): void {
    entry.source?.skipped.add(guid);
    if (!entry.systems.length) {
      this.releaseBundle(entry);
      entry.state = "failed";
      this.reportFailed(entry);
    } else if (entry.state === "playing" && entry.systems.every((other) => other.stopped)) this.beginDrain(entry, "finished");
    else this.startIfReady(entry);
  }

  /** Worst change tier between a prepared bundle's sources and `library`. */
  private changeTier(entry: LiveComponent, library: ParticleLibrary): LibraryChange {
    const source = entry.source;
    const failed = entry.state === "failed";
    // Released bundles and bundles waiting for their owner prepare from the new library.
    if (!source || (!entry.node && !failed) || entry.state === "draining" || entry.state === "retired") return NO_CHANGE;
    if (!sameContent(source.system, library.systems.get(entry.command.particleSystemGuid!))) return BUNDLE_REBUILD;
    let tier: ParticleEmitterChangeTier = "none";
    for (const [guid, previous] of source.emitters) {
      const next = library.emitters.get(guid);
      if (!previous || !next || previous.kind !== next.kind) {
        if (!sameContent(previous, next)) return BUNDLE_REBUILD;
        continue;
      }
      const emitterTier = previous.kind === "basic" && next.kind === "basic"
        ? particleEmitterChangeTier(previous.payload, next.payload)
        : previous.kind === "graph" && next.kind === "graph" ? this.graphChangeTier(previous.document, next.document) : "rebuild";
      if (emitterTier === "none") continue;
      if (failed || source.skipped.has(guid)) return BUNDLE_REBUILD;
      // A Basic rebuild prepares the bundle again; a graph rebuild replaces only its slots.
      if (emitterTier === "rebuild" && previous.kind === "basic") return BUNDLE_REBUILD;
      tier = maxTier(tier, emitterTier);
    }
    return { tier, bundle: false };
  }

  /**
   * `rebuild` when the position-free compile key changes (settings, nodes, edges or
   * values); `live` when only the Material changes (rebound on the running system).
   * Moving a node or renaming the graph changes nothing.
   */
  private graphChangeTier(previous: ParticleGraphDocument, next: ParticleGraphDocument): ParticleEmitterChangeTier {
    if (previous === next) return "none";
    if (this.graphCompileKey(previous) !== this.graphCompileKey(next)) return "rebuild";
    if (previous.materialGuid !== next.materialGuid) return next.materialGuid ? "live" : "rebuild";
    return "none";
  }

  private applyInPlace(entry: LiveComponent): void {
    const source = entry.source!;
    const space = source.system!.space;
    for (const record of [...entry.systems]) {
      // An earlier slot's failure may have released the bundle.
      if (!entry.systems.includes(record)) continue;
      const next = this.library.emitters.get(record.emitterGuid);
      if (record.kind === "graph") {
        if (next?.kind === "graph") this.applyGraphEdit(entry, record, next.document);
        continue;
      }
      if (next?.kind !== "basic") continue;
      const tier = particleEmitterChangeTier(record.payload, next.payload);
      if (tier === "none") continue;
      try {
        const plan = resolveBasicEmitterPlan(next.payload, { backend: record.backend, space });
        applyBasicEmitterPlan(record.system, plan, tier === "respawn" ? "respawn" : "live");
        record.driver.setSchedule(plan.schedule);
        record.lifetime = Math.max(record.lifetime, plan.lifetimeBound);
        record.payload = next.payload;
      } catch (error) {
        this.failSlot(entry, record, entry.generation, error);
      }
    }
    for (const guid of source.emitters.keys()) source.emitters.set(guid, this.library.emitters.get(guid));
  }

  private applyGraphEdit(entry: LiveComponent, record: GraphSlot, document: ParticleGraphDocument): void {
    if (this.graphCompileKey(document) !== record.compileKey || !document.materialGuid) this.rebuildGraphSlot(entry, record);
    else if (document.materialGuid !== record.materialGuid) this.rebindGraphMaterial(entry, record, document.materialGuid);
  }

  /** Replaces one graph slot inside its bundle; the other slots keep their particles. */
  private rebuildGraphSlot(entry: LiveComponent, record: GraphSlot): void {
    const index = entry.systems.indexOf(record);
    const host = entry.scene;
    const node = entry.node;
    const payload = entry.source?.system;
    const emitter = this.library.emitters.get(record.emitterGuid);
    if (index < 0 || !host || !node || !payload || !emitter) return;
    entry.systems.splice(index, 1);
    this.disposeSlots([record]);
    record.lease.release();
    const next = this.prepareSlot(entry, this.slotContext(entry, host, node, payload.space),
      { index: record.index, guid: record.emitterGuid, emitter, rekey: true });
    if (!next) {
      // Reported by `prepareSlot`; an invalid or unbuildable graph leaves the slot skipped.
      this.afterSlotSkipped(entry, record.emitterGuid);
      return;
    }
    entry.systems.splice(index, 0, next);
    if (entry.state === "playing") this.startSystems(entry);
  }

  /**
   * Binds another Material to a running graph system. The previous lease is released once
   * the new Material is bound (or fails), so the system never draws with a released one.
   */
  private rebindGraphMaterial(entry: LiveComponent, record: GraphSlot, materialGuid: string): void {
    const host = entry.scene;
    if (!host) return;
    const generation = entry.generation;
    const lease = this.acquireMaterial?.(materialGuid, { scene: host,
      instanceKey: `particle:${this.ownerId}:${entry.key}:${generation}:${record.index}:${++this.leaseSerial}` }) ?? null;
    if (!lease) {
      this.removeSlot(entry, record, { code: "particle.missing_material", assetGuid: record.emitterGuid,
        message: "Particle Graph has no usable Material (missing, or not in the Particle domain); slot skipped." });
      return;
    }
    const previous = record.lease;
    record.lease = lease;
    record.materialGuid = materialGuid;
    let ready: Promise<void>;
    try {
      ready = bindParticleMaterial(record.system, lease.resource);
    } catch (error) {
      previous.release();
      this.failSlot(entry, record, generation, error);
      return;
    }
    void ready.then(() => previous.release(), () => previous.release());
    this.waitFor(entry, record, generation, ready, lease);
    if (lease.ready) this.waitFor(entry, record, generation, lease.ready, lease);
  }

  private disposeSlots(records: SlotRecord[]): void {
    for (const record of records) {
      for (const cancel of record.cancel.splice(0)) cancel();
      if (record.kind === "basic") record.driver.halt();
      record.system.stop();
      // The default dispose also releases the system's own readiness texture. A graph set
      // disposes its blocks, and its SystemBlock disposes the system; the set never owns the emitter.
      if (record.kind === "graph") record.set.dispose();
      else record.system.dispose();
    }
  }

  private releaseBundle(entry: LiveComponent): void {
    entry.generation = ++this.generation;
    entry.stopBound?.(); entry.stopBound = undefined;
    entry.preparationCheck?.(); entry.preparationCheck = undefined;
    for (const cancel of entry.cancel.splice(0)) cancel();
    const records = entry.systems.splice(0);
    const node = entry.node;
    entry.node = null;
    this.disposeRecords(records, node);
    entry.scene = null;
    entry.building = false;
  }

  /** Disposes native systems, then their emitter node, then releases their Material leases (newest first). */
  private disposeRecords(records: SlotRecord[], node: Mesh | null): void {
    this.disposeSlots(records);
    node?.dispose();
    for (const record of [...records].reverse()) record.lease.release();
  }

  private retire(entry: LiveComponent): void {
    if (this.live.get(entry.key) !== entry) return;
    this.live.delete(entry.key);
    entry.desiredPlaying = false;
    entry.state = "retired";
    this.disposeGhosts(entry);
    this.releaseBundle(entry);
    this.publishStats();
  }

  private publishStats(): void {
    if (this.statsScope === "global") Object.assign(particleStats, this.stats());
  }
}
