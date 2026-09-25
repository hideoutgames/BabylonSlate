import { MeshBuilder, type AbstractMesh, type IParticleSystem, type Mesh, type NodeMaterial, type Scene } from "@babylonjs/core";
import {
  particleEmitterChangeTier,
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
import { DEFAULT_SORTING_LAYERS } from "@babylonslate/core";
import type { ResourceLease } from "./resource-cache";
import { createBasicEmissionDriver, type BasicEmissionDriver } from "./particle-emission-driver";
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
  | "particle.apply_failed";
/** Slot-level problems carry the emitter guid; bundle-level ones the Particle System guid. */
export type ParticleServiceDiagnostic = { code: ParticleDiagnosticCode; message: string; assetGuid?: string };
export type ParticleStats = { systems: number; playing: number; gpu: boolean; gpuSystems: number };
export const particleStats: ParticleStats = { systems: 0, playing: 0, gpu: false, gpuSystems: 0 };
/** GPU `active` is the claimed slot ring, not a live count, so it is marked approximate. */
export type ParticlePreviewStats = {
  active: number;
  capacity: number;
  backend: "gpu" | "cpu" | "mixed" | "none";
  approximate: boolean;
};
export type ParticleMaterialOwner = { scene: Scene; instanceKey: string };
type Assignment = Extract<CommandMessage, { type: "assignParticle" }>;
type PlaybackState = "preparing" | "ready-stopped" | "playing" | "draining" | "failed" | "retired";
type SlotBase = {
  emitterGuid: string;
  system: IParticleSystem;
  lease: ResourceLease<NodeMaterial>;
  pending: number;
  updateSpeed: number;
  /** Native stop (a finished Once emitter) or drain; the emission driver is halted. */
  stopped: boolean;
  cancel: Array<() => void>;
};
/** One native system per prepared slot. PR3 adds a `graph` member to this union. */
type BasicSlot = SlotBase & {
  kind: "basic";
  gpu: boolean;
  backend: ParticleSimBackend;
  /** Source payload, diffed by `updateLibrary`. */
  payload: ParticleEmitterPayload;
  driver: BasicEmissionDriver;
  lifetime: number;
  drainedTime: number;
  lastRenderId: number;
  lastCameraId: number;
};
type SlotRecord = BasicSlot;
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
let nextServiceId = 0;
const emptyLibrary = (): ParticleLibrary => ({ emitters: new Map(), systems: new Map() });
const liveKey = (actorGuid: string, componentId: string): string => `${actorGuid}:${componentId}`;
const TIER_ORDER: readonly ParticleEmitterChangeTier[] = ["none", "live", "respawn", "rebuild"];
const maxTier = (a: ParticleEmitterChangeTier, b: ParticleEmitterChangeTier): ParticleEmitterChangeTier =>
  TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
const sameContent = (a: unknown, b: unknown): boolean => stableStringify(a ?? null) === stableStringify(b ?? null);

/** Babylon throws plain strings; keep their text. */
function describeParticleThrow(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" && error ? error : "Particle preparation failed.";
}

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
  private generation = 0;
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
   * Draining and released bundles pick the change up on their next Play.
   */
  updateLibrary(library: ParticleLibrary): { tier: ParticleEmitterChangeTier } {
    this.library = library;
    let applied: ParticleEmitterChangeTier = "none";
    for (const entry of [...this.live.values()]) {
      if (this.disposed || this.live.get(entry.key) !== entry) continue;
      const tier = this.changeTier(entry);
      if (tier === "none") continue;
      applied = maxTier(applied, tier);
      if (tier === "rebuild") {
        this.releaseBundle(entry);
        this.prepare(entry);
      } else this.applyInPlace(entry);
    }
    this.publishStats();
    return { tier: applied };
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
    for (const entry of this.live.values()) {
      systems += entry.systems.length;
      gpuSystems += entry.systems.filter((record) => record.gpu).length;
      if (entry.desiredPlaying && (entry.state === "preparing" || entry.state === "playing")) playing += 1;
    }
    const gpu = gpuSystems > 0 || gpuParticlesSupported(this.scene.getEngine(), this.gpuRequested);
    return { systems, playing, gpu, gpuSystems };
  }

  /** Preview badges: CPU live counts plus GPU claimed rings (approximate). */
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
    // The owning engine decides, not the last-created one.
    const backend = particleSimBackend(host.getEngine(), this.gpuRequested);
    try {
      const node = MeshBuilder.CreateBox(`particleEmitter:${entry.key}`, { size: 0.01 }, host);
      entry.node = node;
      node.isVisible = true; node.visibility = 0; node.isPickable = false; node.alwaysSelectAsActiveMesh = true;
      const parent = this.slotMeshes.get(entry.command.slotId) ?? this.resolveEmitter?.(entry.command.slotId);
      if (parent?.getScene() === host) node.parent = parent;
      const sorting = resolveSortingLayer(DEFAULT_SORTING_LAYERS, entry.command.sortingLayer?.trim() || "Default", entry.command.orderInLayer ?? 0);
      for (const [index, guid] of payload.emitterGuids.entries()) {
        const emitter = this.library.emitters.get(guid);
        source.emitters.set(guid, emitter);
        if (!emitter) {
          this.onDiagnostic?.({ code: "particle.unknown_emitter", message: "Particle Emitter asset is missing; slot skipped.", assetGuid: guid });
          source.skipped.add(guid);
          continue;
        }
        const record = this.prepareSlot(entry, { host, node, sorting, backend, space: payload.space, index, guid, emitter, generation });
        if (!record) source.skipped.add(guid);
      }
      // No playable slot: behave as an empty bundle without native systems.
      if (!entry.systems.length) { this.releaseBundle(entry); entry.state = "failed"; return; }
      const disposing = host.onDisposeObservable.addOnce(() => this.retire(entry));
      const before = host.onBeforeRenderObservable.add(() => {
        if (!this.current(entry, generation)) return;
        try { for (const record of entry.systems) if (record.gpu) record.lifetime = Math.max(record.lifetime, particleLifetimeBound(record.system)); }
        catch (error) { this.fail(entry, generation, error); }
      });
      const after = host.onAfterRenderObservable.add(() => {
        if (!this.current(entry, generation)) return;
        if (entry.state === "playing") {
          // The driver runs on the simulation clock, so pause (updateSpeed 0) holds it.
          const ratio = host.getAnimationRatio() || 1;
          for (const record of entry.systems) if (!record.stopped) record.driver.advance(record.system.updateSpeed * ratio);
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

  /** Every per-slot failure skips only that slot; the bundle keeps its other slots. */
  private prepareSlot(entry: LiveComponent, slot: {
    host: Scene; node: Mesh; sorting: SortingLayerResolution; backend: ParticleSimBackend; space: ParticleSystemPayload["space"];
    index: number; guid: string; emitter: ParticleLibraryEmitter; generation: number;
  }): SlotRecord | null {
    const { host, guid, generation } = slot;
    const payload = slot.emitter.payload;
    const materialGuid = payload.render.materialGuid;
    const lease = materialGuid
      ? this.acquireMaterial?.(materialGuid, { scene: host, instanceKey: `particle:${this.ownerId}:${entry.key}:${generation}:${slot.index}` }) ?? null
      : null;
    if (!lease) {
      this.onDiagnostic?.({ code: "particle.missing_material", assetGuid: guid, message: materialGuid
        ? "Particle Emitter has no usable Material (missing, or not in the Particle domain); slot skipped."
        : "Particle Emitter has no Material; slot skipped." });
      return null;
    }
    let system: IParticleSystem | null = null;
    try {
      const plan = resolveBasicEmitterPlan(payload, { backend: slot.backend, space: slot.space });
      system = createBabylonParticleSystem(`particle:${entry.key}:${slot.index}`, host, plan.capacity, slot.backend !== "cpu");
      system.emitter = slot.node;
      applyBasicEmitterPlan(system, plan, "create");
      const ready = bindParticleMaterial(system, lease.resource);
      const record: SlotRecord = { kind: "basic", emitterGuid: guid, system, lease, gpu: slot.backend !== "cpu", backend: slot.backend,
        payload, driver: createBasicEmissionDriver(system, plan.schedule), pending: 0, updateSpeed: plan.updateSpeed, stopped: false,
        lifetime: plan.lifetimeBound, drainedTime: 0, lastRenderId: -1, lastCameraId: -1, cancel: [] };
      if (this.paused) system.updateSpeed = 0;
      applySortingToParticleSystem(system, slot.sorting);
      const native = system;
      const stopped = native.onStoppedObservable.add(() => {
        // Babylon notifies before setting its own stopped flag; a drain marks records first.
        if (!this.current(entry, generation) || record.stopped) return;
        record.stopped = true;
        record.driver.halt();
        if (entry.state === "playing" && entry.systems.every((other) => other.stopped)) this.beginDrain(entry);
      });
      record.cancel.push(() => native.onStoppedObservable.remove(stopped));
      if (record.gpu) {
        const draw = native.onBeforeDrawParticlesObservable.add(() => {
          if (!this.current(entry, generation)) return;
          const renderId = host.getRenderId();
          const cameraId = host.activeCamera?.uniqueId ?? -1;
          // MULTIPLYADD draws twice, but Babylon updates once per camera/render ID.
          if (record.lastRenderId === renderId && record.lastCameraId === cameraId) return;
          record.lastRenderId = renderId; record.lastCameraId = cameraId;
          if (record.stopped) record.drainedTime += particleSimulationDelta(native);
        });
        record.cancel.push(() => native.onBeforeDrawParticlesObservable.remove(draw));
      }
      entry.systems.push(record);
      this.waitFor(entry, record, generation, ready);
      if (lease.ready) this.waitFor(entry, record, generation, lease.ready);
      return record;
    } catch (error) {
      system?.dispose();
      lease.release();
      this.onDiagnostic?.({ code: "particle.apply_failed", assetGuid: guid, message: describeParticleThrow(error) });
      return null;
    }
  }

  private waitFor(entry: LiveComponent, record: SlotRecord, generation: number, ready: Promise<void>): void {
    record.pending += 1;
    void ready.then(() => {
      if (!this.current(entry, generation) || !entry.systems.includes(record)) return;
      record.pending -= 1;
      this.startIfReady(entry);
    }, (error: unknown) => this.failSlot(entry, record, generation, error));
  }

  private startIfReady(entry: LiveComponent): void {
    if (!this.current(entry, entry.generation) || entry.building || !entry.systems.length || entry.systems.some((record) => record.pending)) return;
    if (entry.state !== "preparing" && entry.state !== "ready-stopped") return;
    if (entry.timer !== undefined) { clearTimeout(entry.timer); entry.timer = undefined; }
    entry.preparationCheck?.(); entry.preparationCheck = undefined;
    entry.state = entry.desiredPlaying ? "playing" : "ready-stopped";
    if (entry.desiredPlaying) for (const record of entry.systems) {
      if (!this.current(entry, entry.generation) || !entry.desiredPlaying || entry.state !== "playing") break;
      record.system.start(0);
    }
    this.publishStats();
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
      record.lifetime = Math.max(record.lifetime, particleLifetimeBound(record.system));
      if (record.stopped) continue;
      // Halt first: the driver would otherwise restore rate emission over the mute.
      record.driver.halt();
      record.stopped = true;
      record.drainedTime = 0;
      record.system.manualEmitCount = 0;
      record.system.stop();
    }
    this.publishStats();
  }

  private finishDrain(entry: LiveComponent, generation: number): void {
    if (!this.current(entry, generation) || entry.state !== "draining") return;
    // A claimed GPU ring always reports its capacity, so GPU slots wait the lifetime bound.
    const drained = entry.systems.every(({ system, gpu, drainedTime, lifetime }) =>
      gpu ? system.getActiveCount() === 0 || drainedTime > lifetime : system.getActiveCount() === 0);
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
    if (!this.current(entry, generation)) return;
    const index = entry.systems.indexOf(record);
    if (index < 0) return;
    entry.systems.splice(index, 1);
    entry.source?.skipped.add(record.emitterGuid);
    this.disposeSlots([record]);
    record.lease.release();
    this.onDiagnostic?.({ code: "particle.apply_failed", assetGuid: record.emitterGuid, message: describeParticleThrow(error) });
    if (!entry.systems.length) {
      this.releaseBundle(entry);
      entry.state = "failed";
    } else this.startIfReady(entry);
    this.publishStats();
  }

  /** Worst change tier between a prepared bundle's sources and the current library. */
  private changeTier(entry: LiveComponent): ParticleEmitterChangeTier {
    const source = entry.source;
    const failed = entry.state === "failed";
    // Released bundles and bundles waiting for their owner prepare from the new library.
    if (!source || (!entry.node && !failed) || entry.state === "draining" || entry.state === "retired") return "none";
    if (!sameContent(source.system, this.library.systems.get(entry.command.particleSystemGuid!))) return "rebuild";
    let tier: ParticleEmitterChangeTier = "none";
    for (const [guid, previous] of source.emitters) {
      const next = this.library.emitters.get(guid);
      if (!previous || !next || previous.kind !== next.kind) {
        if (!sameContent(previous, next)) return "rebuild";
        continue;
      }
      const emitterTier = particleEmitterChangeTier(previous.payload, next.payload);
      if (emitterTier === "none") continue;
      if (failed || source.skipped.has(guid)) return "rebuild";
      tier = maxTier(tier, emitterTier);
    }
    return tier;
  }

  private applyInPlace(entry: LiveComponent): void {
    const source = entry.source!;
    const space = source.system!.space;
    for (const record of [...entry.systems]) {
      const next = this.library.emitters.get(record.emitterGuid)!;
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

  private disposeSlots(records: SlotRecord[]): void {
    for (const record of records) {
      for (const cancel of record.cancel.splice(0)) cancel();
      record.driver.halt();
      record.system.stop();
      // The default dispose also releases the system's own readiness texture.
      record.system.dispose();
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
