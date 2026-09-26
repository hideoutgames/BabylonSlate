import { MeshBuilder, type AbstractMesh, type IParticleSystem, type Mesh, type NodeMaterial, type NodeParticleSystemSet, type Scene } from "@babylonjs/core";
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
} from "@babylonslate/assets";
import type { CommandMessage } from "@babylonslate/bridge";
import { DEFAULT_SORTING_LAYERS, type ParticleSpace } from "@babylonslate/core";
import {
  lowerParticleGraphDocument,
  particleGraphCompileKey,
  type ParticleBuildPlan,
  type ParticleGraphDocument,
  type ParticleGraphLowerResult,
} from "@babylonslate/particle-graph";
import type { ResourceLease } from "./resource-cache";
import { createBasicEmissionDriver, type BasicEmissionDriver } from "./particle-emission-driver";
import { describeParticleThrow, realizeParticleGraph, type ParticleGraphCompileCode } from "./particle-graph-realize";
import {
  applyBasicEmitterPlan,
  bindParticleMaterial,
  createBabylonParticleSystem,
  gpuParticlesSupported,
  particleLifetimeBound,
  particleSimBackend,
  particleSimulationDelta,
} from "./particle-system-factory";
import { markSceneReadinessDirty, SCENE_SHADER_WARM_TIMEOUT_MS } from "./scene-perf";
import { applySortingToParticleSystem, resolveSortingLayer, type SortingLayerResolution } from "./sorting";

export type { ParticleLibrary, ParticleLibraryEmitter } from "@babylonslate/assets";
export type ParticleDiagnosticCode =
  | "particle.unknown_system"
  | "particle.unknown_emitter"
  | "particle.missing_material"
  | "particle.graph_invalid"
  | ParticleGraphCompileCode
  | "particle.apply_failed";
/**
 * Slot-level problems carry the emitter guid; bundle-level ones the Particle System guid.
 * Particle Graph problems also carry the graph node (and pin) they are anchored to.
 */
export type ParticleServiceDiagnostic = {
  code: ParticleDiagnosticCode;
  message: string;
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
  updateSpeed: number;
  /** Native `start()` ran. Systems readied while paused start on resume, so prewarm runs at speed. */
  started: boolean;
  /** Native stop (a finished Once emitter) or drain; the emission driver is halted. */
  stopped: boolean;
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
  lastRenderId: number;
  lastCameraId: number;
};
/** A Particle Graph slot: always a CPU `ParticleSystem` built from Node Particle blocks. */
type GraphSlot = SlotBase & {
  kind: "graph";
  gpu: false;
  /** Owns every block; disposing it disposes the system and its readiness texture. */
  set: NodeParticleSystemSet;
  /** Position-free plan hash; a change rebuilds only this slot. */
  compileKey: string;
  /** A change rebinds the Material on the running system. */
  materialGuid: string;
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
  state: PlaybackState;
  generation: number;
  scene: Scene | null;
  node: Mesh | null;
  systems: SlotRecord[];
  source: BundleSource | null;
  cancel: Array<() => void>;
  building: boolean;
  timer?: ReturnType<typeof setTimeout>;
  preparationCheck?: () => void;
};
/** An edit's tier, and whether it needs the whole bundle prepared again. */
type LibraryChange = { tier: ParticleEmitterChangeTier; bundle: boolean };
let nextServiceId = 0;
const emptyLibrary = (): ParticleLibrary => ({ emitters: new Map(), systems: new Map() });
const liveKey = (actorGuid: string, componentId: string): string => `${actorGuid}:${componentId}`;
const TIER_ORDER: readonly ParticleEmitterChangeTier[] = ["none", "live", "respawn", "rebuild"];
const maxTier = (a: ParticleEmitterChangeTier, b: ParticleEmitterChangeTier): ParticleEmitterChangeTier =>
  TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
const sameContent = (a: unknown, b: unknown): boolean => stableStringify(a ?? null) === stableStringify(b ?? null);
const NO_CHANGE: LibraryChange = { tier: "none", bundle: false };
const BUNDLE_REBUILD: LibraryChange = { tier: "rebuild", bundle: true };

/** Main-thread owner. Each component incarnation and preparation generation owns its callbacks and native bundle. */
export class ParticleService {
  private readonly ownerId = ++nextServiceId;
  private readonly scene: Scene;
  private readonly gpuRequested: boolean;
  private readonly statsScope: "global" | "local";
  private readonly acquireMaterial?: (guid: string, owner: ParticleMaterialOwner) => ResourceLease<NodeMaterial> | null;
  private readonly resolveEmitter?: (slotId: number) => AbstractMesh | null;
  private sceneForSlot?: (slotId: number) => Scene | null;
  private onDiagnostic?: (diagnostic: ParticleServiceDiagnostic) => void;
  private library: ParticleLibrary = emptyLibrary();
  private readonly live = new Map<string, LiveComponent>();
  private readonly slotMeshes = new Map<number, AbstractMesh | null>();
  /** Library documents are replaced, never mutated, so the document object keys its plan. */
  private readonly plans = new WeakMap<ParticleGraphDocument, ParticleGraphLowerResult>();
  private generation = 0;
  /** Distinguishes Material leases taken for one slot after its preparation (rebuild, rebind). */
  private leaseSerial = 0;
  private paused = false;
  private disposed = false;
  private readonly cancelSceneDispose: () => void;

  constructor(options: {
    scene: Scene;
    gpuSupported?: boolean;
    /** A null lease skips the slot with `particle.missing_material`. */
    acquireMaterial?: (guid: string, owner: ParticleMaterialOwner) => ResourceLease<NodeMaterial> | null;
    resolveEmitter?: (slotId: number) => AbstractMesh | null;
    /** A null result means that the intended owner is not available yet. */
    sceneForSlot?: (slotId: number) => Scene | null;
    onDiagnostic?: (diagnostic: ParticleServiceDiagnostic) => void;
    /** "global" (Play, player) publishes `particleStats`; "local" (previews) only serves `stats()`. */
    statsScope?: "global" | "local";
  }) {
    this.scene = options.scene;
    this.gpuRequested = options.gpuSupported ?? true;
    this.statsScope = options.statsScope ?? "global";
    this.acquireMaterial = options.acquireMaterial;
    this.resolveEmitter = options.resolveEmitter;
    this.sceneForSlot = options.sceneForSlot;
    this.onDiagnostic = options.onDiagnostic;
    const observer = this.scene.onDisposeObservable.addOnce(() => this.dispose());
    this.cancelSceneDispose = () => this.scene.onDisposeObservable.remove(observer);
    this.publishStats();
  }

  setOnDiagnostic(handler: ((diagnostic: ParticleServiceDiagnostic) => void) | undefined): void { this.onDiagnostic = handler; }
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

  bindSlot(slotId: number, mesh: AbstractMesh | null): void {
    this.slotMeshes.set(slotId, mesh);
    for (const entry of this.live.values()) {
      if (entry.command.slotId !== slotId) continue;
      this.refreshOwner(entry);
      if (entry.node) entry.node.parent = mesh?.getScene() === entry.scene ? mesh : null;
    }
  }

  retireSlots(matches: (slotId: number) => boolean): void {
    for (const entry of this.live.values()) if (matches(entry.command.slotId)) this.retire(entry);
    for (const slot of this.slotMeshes.keys()) if (matches(slot)) this.slotMeshes.delete(slot);
    this.publishStats();
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    for (const entry of this.live.values()) for (const record of entry.systems) {
      if (paused) record.updateSpeed = record.system.updateSpeed;
      record.system.updateSpeed = paused ? 0 : record.updateSpeed;
    }
    if (paused) return;
    // Speeds are restored first: CPU prewarm runs inside `start()`, GPU prewarm on the first render.
    for (const entry of [...this.live.values()]) if (entry.state === "playing") this.startSystems(entry);
    this.publishStats();
  }

  handleCommand(command: CommandMessage): void {
    if (this.disposed) return;
    if (command.type === "despawn" || command.type === "spawn") this.retireSlots((slot) => slot === command.slotId);
    else if (command.type === "assignParticle") this.assign(command);
    else if (command.type === "setParticlePlaying") {
      for (const entry of this.live.values()) {
        if (entry.command.actorGuid !== command.actorGuid || (command.componentId && entry.command.componentId !== command.componentId)) continue;
        if (command.playing) {
          if (entry.desiredPlaying) continue;
          entry.desiredPlaying = true;
          if (entry.state === "draining") this.releaseBundle(entry);
          if (!entry.node) this.prepare(entry);
          else this.startIfReady(entry);
        } else this.stop(entry);
      }
      this.publishStats();
    }
  }

  stats(): ParticleStats {
    let systems = 0;
    let playing = 0;
    let gpuSystems = 0;
    let graphSystems = 0;
    for (const entry of this.live.values()) {
      systems += entry.systems.length;
      for (const record of entry.systems) {
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
    for (const entry of this.live.values()) for (const record of entry.systems) {
      active += record.system.getActiveCount();
      capacity += record.system.getCapacity();
      if (record.gpu) gpu += 1;
      else cpu += 1;
    }
    const backend = gpu && cpu ? "mixed" : gpu ? "gpu" : cpu ? "cpu" : "none";
    return { active, capacity, backend, approximate: gpu > 0 };
  }

  resetSession(): void {
    for (const entry of this.live.values()) this.retire(entry);
    this.slotMeshes.clear();
    this.publishStats();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelSceneDispose();
    this.resetSession();
    this.library = emptyLibrary();
  }

  private assign(command: Assignment): void {
    const key = liveKey(command.actorGuid, command.componentId);
    const previous = this.live.get(key);
    if (previous) this.retire(previous);
    const guid = command.particleSystemGuid?.trim();
    if (!guid) { this.publishStats(); return; }
    if (!this.library.systems.has(guid)) {
      this.onDiagnostic?.({ code: "particle.unknown_system", message: "Particle System asset is missing; playback skipped.", assetGuid: guid });
      this.publishStats(); return;
    }
    // Desired state is published before any native or material callback can run.
    const entry: LiveComponent = { key, command: { ...command, particleSystemGuid: guid }, desiredPlaying: command.play !== false,
      state: "preparing", generation: 0, scene: null, node: null, systems: [], source: null, cancel: [], building: false };
    this.live.set(key, entry);
    this.prepare(entry);
    this.publishStats();
  }

  private hostFor(entry: LiveComponent): Scene | null {
    return this.sceneForSlot ? this.sceneForSlot(entry.command.slotId) : this.scene;
  }

  private current(entry: LiveComponent, generation: number): boolean {
    return !this.disposed && this.live.get(entry.key) === entry && entry.generation === generation &&
      entry.state !== "retired" && !entry.scene?.isDisposed && this.hostFor(entry) === entry.scene;
  }

  private refreshOwner(entry: LiveComponent): void {
    const host = this.hostFor(entry);
    if (host === entry.scene && entry.node) return;
    this.releaseBundle(entry);
    this.prepare(entry);
  }

  private slotContext(entry: LiveComponent, host: Scene, node: Mesh, space: ParticleSpace): SlotContext {
    return {
      host, node, space, generation: entry.generation,
      sorting: resolveSortingLayer(DEFAULT_SORTING_LAYERS, entry.command.sortingLayer?.trim() || "Default", entry.command.orderInLayer ?? 0),
      // The owning engine decides, not the last-created one.
      backend: particleSimBackend(host.getEngine(), this.gpuRequested),
    };
  }

  private prepare(entry: LiveComponent): void {
    const host = this.hostFor(entry);
    entry.state = "preparing";
    if (!host || host.isDisposed) return;
    const payload = this.library.systems.get(entry.command.particleSystemGuid!) ?? null;
    const source: BundleSource = { system: payload, emitters: new Map(), skipped: new Set() };
    entry.source = source;
    if (!payload) { entry.state = "failed"; return; }
    entry.scene = host;
    entry.generation = ++this.generation;
    entry.building = true;
    const generation = entry.generation;
    try {
      const node = MeshBuilder.CreateBox(`particleEmitter:${entry.key}`, { size: 0.01 }, host);
      entry.node = node;
      node.isVisible = true; node.visibility = 0; node.isPickable = false; node.alwaysSelectAsActiveMesh = true;
      const parent = this.slotMeshes.get(entry.command.slotId) ?? this.resolveEmitter?.(entry.command.slotId);
      if (parent?.getScene() === host) node.parent = parent;
      const context = this.slotContext(entry, host, node, payload.space);
      for (const [index, guid] of payload.emitterGuids.entries()) {
        const emitter = this.library.emitters.get(guid);
        source.emitters.set(guid, emitter);
        if (!emitter) {
          this.onDiagnostic?.({ code: "particle.unknown_emitter", message: "Particle Emitter asset is missing; slot skipped.", assetGuid: guid });
          source.skipped.add(guid);
          continue;
        }
        const record = this.prepareSlot(entry, context, { index, guid, emitter });
        if (record) entry.systems.push(record);
        else source.skipped.add(guid);
      }
      // No playable slot: behave as an empty bundle without native systems.
      if (!entry.systems.length) { this.releaseBundle(entry); entry.state = "failed"; return; }
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
        if (entry.state === "playing") {
          // The driver runs on the simulation clock, so pause (updateSpeed 0) holds it.
          const ratio = host.getAnimationRatio() || 1;
          for (const record of entry.systems) {
            if (record.kind === "basic" && !record.stopped && !record.prewarmPending) record.driver.advance(record.system.updateSpeed * ratio);
          }
        }
        this.finishDrain(entry, generation);
      });
      entry.cancel.push(() => host.onDisposeObservable.remove(disposing), () => host.onBeforeRenderObservable.remove(before), () => host.onAfterRenderObservable.remove(after));
      entry.building = false;
      if (entry.systems.some((record) => record.pending)) {
        const readiness = { isReady: () => false };
        host.addIsReadyCheck(readiness);
        markSceneReadinessDirty(host);
        entry.preparationCheck = () => {
          host.removeIsReadyCheck(readiness);
          markSceneReadinessDirty(host);
        };
        entry.timer = setTimeout(() => this.fail(entry, generation, new Error("Particle preparation timed out.")), SCENE_SHADER_WARM_TIMEOUT_MS);
      }
      this.startIfReady(entry);
    } catch (error) { this.fail(entry, generation, error); }
  }

  private planFor(document: ParticleGraphDocument): ParticleGraphLowerResult {
    let lowered = this.plans.get(document);
    if (!lowered) {
      lowered = lowerParticleGraphDocument(document);
      this.plans.set(document, lowered);
    }
    return lowered;
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
      this.onDiagnostic?.({ code: "particle.missing_material", assetGuid: guid, message: `${label} has no Material; slot skipped.` });
      return null;
    }
    let plan: ParticleBuildPlan | null = null;
    if (emitter.kind === "graph") {
      const lowered = this.planFor(emitter.document);
      if (!lowered.ok) {
        const errors = lowered.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
        const first = errors[0];
        this.onDiagnostic?.({ code: "particle.graph_invalid", assetGuid: guid,
          message: `Particle Graph has ${errors.length} ${errors.length === 1 ? "error" : "errors"}; slot skipped.${first ? ` ${first.message}` : ""}`,
          ...(first?.nodeId ? { nodeId: first.nodeId } : {}), ...(first?.pinId ? { pinId: first.pinId } : {}) });
        return null;
      }
      plan = lowered.plan;
    }
    const instanceKey = `particle:${this.ownerId}:${entry.key}:${generation}:${slot.index}${slot.rekey ? `:${++this.leaseSerial}` : ""}`;
    const lease = this.acquireMaterial?.(materialGuid, { scene: host, instanceKey }) ?? null;
    if (!lease) {
      this.onDiagnostic?.({ code: "particle.missing_material", assetGuid: guid,
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
      const ready = bindParticleMaterial(system, lease.resource);
      if (this.paused) system.updateSpeed = 0;
      applySortingToParticleSystem(system, context.sorting);
      const owned = record;
      const stopped = system.onStoppedObservable.add(() => {
        // Babylon notifies before setting its own stopped flag; a drain marks records first.
        if (!this.current(entry, generation) || owned.stopped) return;
        owned.stopped = true;
        if (owned.kind === "basic") owned.driver.halt();
        if (entry.state === "playing" && entry.systems.every((other) => other.stopped)) this.beginDrain(entry);
      });
      record.cancel.push(() => system.onStoppedObservable.remove(stopped));
      if (record.kind === "basic" && record.gpu) {
        const basic = record;
        const draw = system.onBeforeDrawParticlesObservable.add(() => {
          if (!this.current(entry, generation)) return;
          // Babylon draws only after its prewarm, so bursts queued from now on are rendered.
          basic.prewarmPending = false;
          const renderId = host.getRenderId();
          const cameraId = host.activeCamera?.uniqueId ?? -1;
          // MULTIPLYADD draws twice, but Babylon updates once per camera/render ID.
          if (basic.lastRenderId === renderId && basic.lastCameraId === cameraId) return;
          basic.lastRenderId = renderId; basic.lastCameraId = cameraId;
          if (basic.stopped) basic.drainedTime += particleSimulationDelta(system);
        });
        record.cancel.push(() => system.onBeforeDrawParticlesObservable.remove(draw));
      }
      this.waitFor(entry, record, generation, ready);
      if (lease.ready) this.waitFor(entry, record, generation, lease.ready);
      if (created.buildReady) this.waitFor(entry, record, generation, created.buildReady);
      return record;
    } catch (error) {
      if (record) this.disposeSlots([record]);
      lease.release();
      this.onDiagnostic?.({ code: "particle.apply_failed", assetGuid: guid, message: describeParticleThrow(error) });
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
        pending: 0, updateSpeed: plan.updateSpeed, started: false, stopped: false,
        lifetime: plan.lifetimeBound, drainedTime: 0, lastRenderId: -1, lastCameraId: -1, cancel: [] } };
    } catch (error) {
      system.dispose();
      throw error;
    }
  }

  /** Builds synchronously; build problems are reported per graph node and skip only this slot. */
  private createGraphSlot(entry: LiveComponent, context: SlotContext, slot: { index: number; guid: string },
    plan: ParticleBuildPlan, lease: ResourceLease<NodeMaterial>, materialGuid: string): CreatedSlot | null {
    const realized = realizeParticleGraph(plan, { scene: context.host, name: `particle:${entry.key}:${slot.index}`,
      emitter: context.node, space: context.space });
    if (realized.ok === false) {
      for (const diagnostic of realized.diagnostics) this.onDiagnostic?.({ ...diagnostic, assetGuid: slot.guid });
      return null;
    }
    return {
      record: { kind: "graph", gpu: false, index: slot.index, emitterGuid: slot.guid, system: realized.system, lease,
        set: realized.set, compileKey: plan.hash, materialGuid, pending: 0, updateSpeed: realized.system.updateSpeed,
        started: false, stopped: false, cancel: [] },
      buildReady: realized.buildReady,
    };
  }

  private waitFor(entry: LiveComponent, record: SlotRecord, generation: number, ready: Promise<void>): void {
    record.pending += 1;
    void ready.then(() => {
      if (!this.current(entry, generation) || !entry.systems.includes(record)) return;
      record.pending -= 1;
      // A slot rebuilt inside a playing bundle starts on its own.
      if (entry.state === "playing") this.startSystems(entry);
      else this.startIfReady(entry);
    }, (error: unknown) => this.failSlot(entry, record, generation, error));
  }

  private startIfReady(entry: LiveComponent): void {
    if (!this.current(entry, entry.generation) || entry.building || !entry.systems.length || entry.systems.some((record) => record.pending)) return;
    if (entry.state !== "preparing" && entry.state !== "ready-stopped") return;
    if (entry.timer !== undefined) { clearTimeout(entry.timer); entry.timer = undefined; }
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
    if (this.paused) return;
    for (const record of entry.systems) {
      // A start observer may Stop or replace the entry.
      if (!this.current(entry, entry.generation) || !entry.desiredPlaying || entry.state !== "playing") break;
      if (record.started || record.pending) continue;
      record.started = true;
      record.system.start(0);
    }
  }

  private stop(entry: LiveComponent): void {
    entry.desiredPlaying = false;
    if (entry.state === "preparing" || entry.state === "failed") {
      this.releaseBundle(entry);
      entry.state = "ready-stopped";
    } else if (entry.state === "playing") this.beginDrain(entry);
  }

  /** Stops every emitter that is still running; Once emitters that finished earlier keep their drain time. */
  private beginDrain(entry: LiveComponent): void {
    if (this.live.get(entry.key) !== entry || entry.state !== "playing") return;
    entry.desiredPlaying = false;
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
    // A claimed GPU ring always reports its capacity, so GPU slots wait the lifetime bound;
    // CPU slots (the Basic fallback and every Particle Graph) count live particles.
    // A system stopped before it started (paused) never emitted.
    const drained = entry.systems.every((record) => !record.started || (record.kind === "basic" && record.gpu
      ? record.system.getActiveCount() === 0 || record.drainedTime > record.lifetime
      : record.system.getActiveCount() === 0));
    if (!drained) return;
    this.releaseBundle(entry);
    entry.state = "ready-stopped";
    this.publishStats();
  }

  /** Bundle-level failure: preparation timeout or a native throw outside one slot. */
  private fail(entry: LiveComponent, generation: number, error: unknown): void {
    if (!this.current(entry, generation)) return;
    this.releaseBundle(entry);
    entry.state = "failed";
    this.onDiagnostic?.({ code: "particle.apply_failed", assetGuid: entry.command.particleSystemGuid ?? undefined,
      message: describeParticleThrow(error) });
    this.publishStats();
  }

  /** An async Material failure retires only its slot; the other slots may start. */
  private failSlot(entry: LiveComponent, record: SlotRecord, generation: number, error: unknown): void {
    if (!this.current(entry, generation) || !entry.systems.includes(record)) return;
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
    if (diagnostic) this.onDiagnostic?.(diagnostic);
    this.afterSlotSkipped(entry, record.emitterGuid);
  }

  /** A bundle without its last slot fails; one whose remaining slots all stopped drains. */
  private afterSlotSkipped(entry: LiveComponent, guid: string): void {
    entry.source?.skipped.add(guid);
    if (!entry.systems.length) {
      this.releaseBundle(entry);
      entry.state = "failed";
    } else if (entry.state === "playing" && entry.systems.every((other) => other.stopped)) this.beginDrain(entry);
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
    this.waitFor(entry, record, generation, ready);
    if (lease.ready) this.waitFor(entry, record, generation, lease.ready);
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
    if (entry.timer !== undefined) { clearTimeout(entry.timer); entry.timer = undefined; }
    entry.preparationCheck?.(); entry.preparationCheck = undefined;
    for (const cancel of entry.cancel.splice(0)) cancel();
    const records = entry.systems.splice(0);
    this.disposeSlots(records);
    entry.node?.dispose(); entry.node = null;
    for (const record of records.reverse()) record.lease.release();
    entry.scene = null;
    entry.building = false;
  }

  private retire(entry: LiveComponent): void {
    if (this.live.get(entry.key) !== entry) return;
    this.live.delete(entry.key);
    entry.desiredPlaying = false;
    entry.state = "retired";
    this.releaseBundle(entry);
    this.publishStats();
  }

  private publishStats(): void {
    if (this.statsScope === "global") Object.assign(particleStats, this.stats());
  }
}
