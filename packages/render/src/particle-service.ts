import { MeshBuilder, type AbstractMesh, type IParticleSystem, type Mesh, type NodeMaterial, type Scene, type Texture } from "@babylonjs/core";
import type { ParticleEmitterPayload, ParticleSystemPayload } from "@babylonslate/assets";
import type { CommandMessage } from "@babylonslate/bridge";
import { DEFAULT_SORTING_LAYERS } from "@babylonslate/core";
import type { ResourceLease } from "./resource-cache";
import { applyParticleLook, createBabylonParticleSystem, gpuParticlesSupported, particleCapacityFor, particleLifetimeBound, particleSimulationDelta } from "./particle-system-factory";
import { markSceneReadinessDirty, SCENE_SHADER_WARM_TIMEOUT_MS } from "./scene-perf";
import { applySortingToParticleSystem, resolveSortingLayer } from "./sorting";

export type ParticleLibrary = {
  emitters: ReadonlyMap<string, ParticleEmitterPayload>;
  systems: ReadonlyMap<string, ParticleSystemPayload>;
};
export type ParticleServiceDiagnostic = { code: string; message: string; assetGuid?: string };
export type ParticleStats = { systems: number; playing: number; gpu: boolean };
export const particleStats: ParticleStats = { systems: 0, playing: 0, gpu: false };
export type ParticleMaterialOwner = { scene: Scene; instanceKey: string };
type Assignment = Extract<CommandMessage, { type: "assignParticle" }>;
type PlaybackState = "preparing" | "ready-stopped" | "playing" | "draining" | "failed" | "retired";
type NativeEmitter = {
  system: IParticleSystem;
  gpu: boolean;
  pending: number;
  lifetime: number;
  drainedTime: number;
  lastRenderId: number;
  lastCameraId: number;
  updateSpeed: number;
};
type LiveComponent = {
  key: string;
  command: Assignment;
  desiredPlaying: boolean;
  state: PlaybackState;
  generation: number;
  scene: Scene | null;
  node: Mesh | null;
  systems: NativeEmitter[];
  leases: ResourceLease<Texture | NodeMaterial>[];
  cancel: Array<() => void>;
  building: boolean;
  timer?: ReturnType<typeof setTimeout>;
  preparationCheck?: () => void;
};
let nextServiceId = 0;
const emptyLibrary = (): ParticleLibrary => ({ emitters: new Map(), systems: new Map() });
const liveKey = (actorGuid: string, componentId: string): string => `${actorGuid}:${componentId}`;

/** Main-thread owner. Each component incarnation and preparation generation owns its callbacks and native bundle. */
export class ParticleService {
  private readonly ownerId = ++nextServiceId;
  private readonly scene: Scene;
  private readonly gpuRequested: boolean;
  private readonly resolveTexture?: (guid: string) => Texture | null;
  private readonly acquireTexture?: (guid: string) => ResourceLease<Texture> | null;
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
    /** Borrowed, externally owned textures (e.g. procedural preview fixtures). */
    resolveTexture?: (guid: string) => Texture | null;
    acquireTexture?: (guid: string) => ResourceLease<Texture> | null;
    acquireMaterial?: (guid: string, owner: ParticleMaterialOwner) => ResourceLease<NodeMaterial> | null;
    resolveEmitter?: (slotId: number) => AbstractMesh | null;
    /** A null result means that the intended owner is not available yet. */
    sceneForSlot?: (slotId: number) => Scene | null;
    onDiagnostic?: (diagnostic: ParticleServiceDiagnostic) => void;
  }) {
    this.scene = options.scene;
    this.gpuRequested = options.gpuSupported ?? true;
    this.resolveTexture = options.resolveTexture;
    this.acquireTexture = options.acquireTexture;
    this.acquireMaterial = options.acquireMaterial;
    this.resolveEmitter = options.resolveEmitter;
    this.sceneForSlot = options.sceneForSlot;
    this.onDiagnostic = options.onDiagnostic;
    const observer = this.scene.onDisposeObservable.addOnce(() => this.dispose());
    this.cancelSceneDispose = () => this.scene.onDisposeObservable.remove(observer);
    this.publishStats();
  }

  setOnDiagnostic(handler: ((diagnostic: ParticleServiceDiagnostic) => void) | undefined): void { this.onDiagnostic = handler; }
  setLibrary(library: ParticleLibrary): void { this.library = library; }
  setSceneForSlot(resolver: ((slotId: number) => Scene | null) | undefined): void {
    this.sceneForSlot = resolver;
    for (const entry of this.live.values()) this.refreshOwner(entry);
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
    let gpu = gpuParticlesSupported(this.scene.getEngine(), this.gpuRequested);
    for (const entry of this.live.values()) {
      systems += entry.systems.length;
      if (entry.desiredPlaying && (entry.state === "preparing" || entry.state === "playing")) playing += 1;
      if (entry.systems.some((record) => record.gpu)) gpu = true;
    }
    return { systems, playing, gpu };
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
    // Desired state is published before any native or texture callback can run.
    const entry: LiveComponent = { key, command: { ...command, particleSystemGuid: guid }, desiredPlaying: command.play !== false,
      state: "preparing", generation: 0, scene: null, node: null, systems: [], leases: [], cancel: [], building: false };
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
    const payload = this.library.systems.get(entry.command.particleSystemGuid!);
    if (!payload) { entry.state = "failed"; return; }
    entry.scene = host;
    entry.generation = ++this.generation;
    entry.building = true;
    const generation = entry.generation;
    const gpu = gpuParticlesSupported(host.getEngine(), this.gpuRequested);
    try {
      const node = MeshBuilder.CreateBox(`particleEmitter:${entry.key}`, { size: 0.01 }, host);
      entry.node = node;
      node.isVisible = true; node.visibility = 0; node.isPickable = false; node.alwaysSelectAsActiveMesh = true;
      const parent = this.slotMeshes.get(entry.command.slotId) ?? this.resolveEmitter?.(entry.command.slotId);
      if (parent?.getScene() === host) node.parent = parent;
      const sorting = resolveSortingLayer(DEFAULT_SORTING_LAYERS, entry.command.sortingLayer?.trim() || "Default", entry.command.orderInLayer ?? 0);
      for (const [index, guid] of payload.emitterGuids.entries()) {
        const emitter = this.library.emitters.get(guid);
        if (!emitter) {
          this.onDiagnostic?.({ code: "particle.unknown_emitter", message: "Particle Emitter asset is missing; slot skipped.", assetGuid: guid });
          continue;
        }
        const textureGuid = emitter.textureGuid?.trim();
        const textureLease = textureGuid ? this.acquireTexture?.(textureGuid) : null;
        if (textureLease) entry.leases.push(textureLease);
        const texture = textureLease?.resource ?? (textureGuid ? this.resolveTexture?.(textureGuid) : null);
        if (!texture) {
          this.onDiagnostic?.({ code: "particle.missing_texture", message: "Particle Emitter has no Texture; slot skipped.", assetGuid: guid });
          continue;
        }
        if (!textureLease) texture.hasAlpha = true;
        const system = createBabylonParticleSystem(`particle:${entry.key}:${index}`, host, particleCapacityFor(emitter, gpu), gpu);
        const record: NativeEmitter = { system, gpu, pending: 0, lifetime: 0, drainedTime: 0, lastRenderId: -1, lastCameraId: -1, updateSpeed: system.updateSpeed };
        entry.systems.push(record);
        system.emitter = node;
        const materialLease = emitter.materialGuid ? this.acquireMaterial?.(emitter.materialGuid, {
          scene: host, instanceKey: `particle:${this.ownerId}:${entry.key}:${generation}:${index}`,
        }) : null;
        if (materialLease) entry.leases.push(materialLease);
        if (emitter.materialGuid && !materialLease) throw new Error("Particle material is unavailable.");
        const ready = applyParticleLook({ system, emitter, systemPayload: payload, gpu, texture, material: materialLease?.resource ?? null });
        record.lifetime = particleLifetimeBound(system);
        if (this.paused) system.updateSpeed = 0;
        applySortingToParticleSystem(system, sorting);
        if (ready) this.waitFor(entry, record, generation, ready);
        if (materialLease?.ready) this.waitFor(entry, record, generation, materialLease.ready);
        if (textureLease?.ready) this.waitFor(entry, record, generation, textureLease.ready);
        else if (!texture.isReady() && texture.url) {
          record.pending += 1;
          const observer = texture.onLoadObservable.addOnce(() => {
            if (!this.current(entry, generation)) return;
            record.pending -= 1;
            this.startIfReady(entry);
          });
          entry.cancel.push(() => texture.onLoadObservable.remove(observer));
        }
        const stopped = system.onStoppedObservable.add(() => {
          if (this.current(entry, generation)) this.beginDrain(entry, system);
        });
        entry.cancel.push(() => system.onStoppedObservable.remove(stopped));
        if (gpu) {
          const draw = system.onBeforeDrawParticlesObservable.add(() => {
            if (!this.current(entry, generation)) return;
            const renderId = host.getRenderId();
            const cameraId = host.activeCamera?.uniqueId ?? -1;
            // MULTIPLYADD draws twice, but Babylon updates once per camera/render ID.
            if (record.lastRenderId === renderId && record.lastCameraId === cameraId) return;
            record.lastRenderId = renderId; record.lastCameraId = cameraId;
            if (entry.state === "draining") record.drainedTime += particleSimulationDelta(system);
          });
          entry.cancel.push(() => system.onBeforeDrawParticlesObservable.remove(draw));
        }
      }
      if (!entry.systems.length) { this.releaseBundle(entry); entry.state = "failed"; return; }
      const disposing = host.onDisposeObservable.addOnce(() => this.retire(entry));
      const before = host.onBeforeRenderObservable.add(() => {
        if (!this.current(entry, generation)) return;
        try { for (const record of entry.systems) record.lifetime = Math.max(record.lifetime, particleLifetimeBound(record.system)); }
        catch (error) { this.fail(entry, generation, error); }
      });
      const after = host.onAfterRenderObservable.add(() => this.finishDrain(entry, generation));
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

  private waitFor(entry: LiveComponent, record: NativeEmitter, generation: number, ready: Promise<void>): void {
    record.pending += 1;
    void ready.then(() => {
      if (!this.current(entry, generation)) return;
      record.pending -= 1;
      this.startIfReady(entry);
    }, (error: unknown) => this.fail(entry, generation, error));
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

  private beginDrain(entry: LiveComponent, alreadyStopped?: IParticleSystem): void {
    if (this.live.get(entry.key) !== entry || entry.state !== "playing") return;
    entry.desiredPlaying = false;
    entry.state = "draining";
    for (const record of entry.systems) {
      record.lifetime = Math.max(record.lifetime, particleLifetimeBound(record.system));
      record.drainedTime = 0;
      record.system.manualEmitCount = 0;
      // Babylon notifies before setting its stopped flag; don't recursively stop it.
      if (record.system !== alreadyStopped) record.system.stop();
    }
    this.publishStats();
  }

  private finishDrain(entry: LiveComponent, generation: number): void {
    if (!this.current(entry, generation) || entry.state !== "draining") return;
    const drained = entry.systems.every(({ system, gpu, drainedTime, lifetime }) =>
      gpu ? system.getActiveCount() === 0 || drainedTime > lifetime : system.getActiveCount() === 0);
    if (!drained) return;
    this.releaseBundle(entry);
    entry.state = "ready-stopped";
    this.publishStats();
  }

  private fail(entry: LiveComponent, generation: number, error: unknown): void {
    if (!this.current(entry, generation)) return;
    this.releaseBundle(entry);
    entry.state = "failed";
    this.onDiagnostic?.({ code: "particle.apply_failed", assetGuid: entry.command.particleSystemGuid ?? undefined,
      message: error instanceof Error ? error.message : "Particle preparation failed." });
    this.publishStats();
  }

  private releaseBundle(entry: LiveComponent): void {
    entry.generation = ++this.generation;
    if (entry.timer !== undefined) { clearTimeout(entry.timer); entry.timer = undefined; }
    entry.preparationCheck?.(); entry.preparationCheck = undefined;
    for (const cancel of entry.cancel.splice(0)) cancel();
    for (const { system } of entry.systems.splice(0)) { system.stop(); system.dispose(false); }
    entry.node?.dispose(); entry.node = null;
    for (const lease of entry.leases.splice(0)) lease.release();
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

  private publishStats(): void { Object.assign(particleStats, this.stats()); }
}
