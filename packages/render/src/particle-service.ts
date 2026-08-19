import {
  MeshBuilder,
  Texture,
  type AbstractMesh,
  type IParticleSystem,
  type Mesh,
  type NodeMaterial,
  type Scene,
} from "@babylonjs/core";
import type {
  ParticleEmitterPayload,
  ParticleSystemPayload,
} from "@babylonslate/assets";
import type { CommandMessage } from "@babylonslate/bridge";
import { DEFAULT_SORTING_LAYERS } from "@babylonslate/core";
import {
  applyParticleLook,
  createBabylonParticleSystem,
  gpuParticlesSupported,
  particleCapacityFor,
} from "./particle-system-factory";
import { applySortingToParticleSystem, resolveSortingLayer } from "./sorting";

export type ParticleLibrary = {
  emitters: ReadonlyMap<string, ParticleEmitterPayload>;
  systems: ReadonlyMap<string, ParticleSystemPayload>;
};

export type ParticleServiceDiagnostic = {
  code: string;
  message: string;
  assetGuid?: string;
};

export type ParticleStats = {
  systems: number;
  playing: number;
  gpu: boolean;
};

export const particleStats: ParticleStats = {
  systems: 0,
  playing: 0,
  gpu: false,
};

type ParticleCommand = Extract<
  CommandMessage,
  { type: "assignParticle" } | { type: "setParticlePlaying" }
>;

type LiveComponent = {
  actorGuid: string;
  componentId: string;
  slotId: number;
  systems: IParticleSystem[];
  node: Mesh;
  playing: boolean;
};

function emptyLibrary(): ParticleLibrary {
  return { emitters: new Map(), systems: new Map() };
}

function isParticleCommand(
  command: CommandMessage,
): command is ParticleCommand {
  return (
    command.type === "assignParticle" || command.type === "setParticlePlaying"
  );
}

function liveKey(actorGuid: string, componentId: string): string {
  return `${actorGuid}:${componentId}`;
}

/**
 * Main-thread owner of live Babylon `GPUParticleSystem` / `ParticleSystem`
 * instances. The game worker never imports Babylon.
 */
export class ParticleService {
  private readonly scene: Scene;
  private readonly gpu: boolean;
  private readonly resolveTexture: (guid: string) => Texture | null;
  private readonly resolveMaterial?: (guid: string) => NodeMaterial | null;
  private readonly resolveEmitter?: (
    slotId: number,
  ) => AbstractMesh | Mesh | null;
  private onDiagnostic?: (diagnostic: ParticleServiceDiagnostic) => void;
  private library: ParticleLibrary = emptyLibrary();
  private readonly live = new Map<string, LiveComponent>();
  private readonly slotMeshes = new Map<number, AbstractMesh | null>();

  constructor(options: {
    scene: Scene;
    gpuSupported?: boolean;
    resolveTexture: (guid: string) => Texture | null;
    resolveMaterial?: (guid: string) => NodeMaterial | null;
    resolveEmitter?: (slotId: number) => AbstractMesh | null;
    onDiagnostic?: (diagnostic: ParticleServiceDiagnostic) => void;
  }) {
    this.scene = options.scene;
    this.gpu = gpuParticlesSupported(options.gpuSupported ?? true);
    this.resolveTexture = options.resolveTexture;
    this.resolveMaterial = options.resolveMaterial;
    this.resolveEmitter = options.resolveEmitter;
    this.onDiagnostic = options.onDiagnostic;
    this.publishStats();
  }

  setOnDiagnostic(
    handler: ((diagnostic: ParticleServiceDiagnostic) => void) | undefined,
  ): void {
    this.onDiagnostic = handler;
  }

  setLibrary(library: ParticleLibrary): void {
    this.library = library;
  }

  bindSlot(slotId: number, mesh: AbstractMesh | null): void {
    this.slotMeshes.set(slotId, mesh);
    for (const entry of this.live.values()) {
      if (entry.slotId !== slotId) continue;
      entry.node.parent = mesh;
    }
  }

  handleCommand(command: CommandMessage): void {
    if (!isParticleCommand(command)) return;
    if (command.type === "assignParticle") {
      this.assign(command);
      return;
    }
    this.setPlaying(command);
  }

  stats(): ParticleStats {
    return { ...particleStats };
  }

  resetSession(): void {
    for (const key of [...this.live.keys()]) this.disposeLive(key);
    this.publishStats();
  }

  dispose(): void {
    this.resetSession();
    this.slotMeshes.clear();
    this.library = emptyLibrary();
    this.publishStats();
  }

  private assign(
    command: Extract<CommandMessage, { type: "assignParticle" }>,
  ): void {
    const key = liveKey(command.actorGuid, command.componentId);
    this.disposeLive(key);
    const systemGuid = command.particleSystemGuid?.trim() || null;
    if (!systemGuid) {
      this.publishStats();
      return;
    }
    const systemPayload = this.library.systems.get(systemGuid);
    if (!systemPayload) {
      this.onDiagnostic?.({
        code: "particle.unknown_system",
        message: "Particle System asset is missing; playback skipped.",
        assetGuid: systemGuid,
      });
      this.publishStats();
      return;
    }
    const node = MeshBuilder.CreateBox(`particleEmitter:${key}`, { size: 0.01 }, this.scene);
    node.isVisible = true;
    node.visibility = 0;
    node.isPickable = false;
    node.alwaysSelectAsActiveMesh = true;
    const parent =
      this.slotMeshes.get(command.slotId) ??
      this.resolveEmitter?.(command.slotId) ??
      null;
    if (parent) node.parent = parent;
    const systems: IParticleSystem[] = [];
    systemPayload.emitterGuids.forEach((emitterGuid, index) => {
      const emitter = this.library.emitters.get(emitterGuid);
      if (!emitter) {
        this.onDiagnostic?.({
          code: "particle.unknown_emitter",
          message: "Particle Emitter asset is missing; slot skipped.",
          assetGuid: emitterGuid,
        });
        return;
      }
      const textureGuid = emitter.textureGuid?.trim() || null;
      const texture = textureGuid ? this.resolveTexture(textureGuid) : null;
      if (!texture) {
        this.onDiagnostic?.({
          code: "particle.missing_texture",
          message: "Particle Emitter has no Texture; slot skipped.",
          assetGuid: emitterGuid,
        });
        return;
      }
      texture.hasAlpha = true;
      const capacity = particleCapacityFor(emitter, this.gpu);
      const system = createBabylonParticleSystem(
        `particle:${key}:${index}`,
        this.scene,
        capacity,
        this.gpu,
      );
      system.emitter = node;
      const material = emitter.materialGuid
        ? (this.resolveMaterial?.(emitter.materialGuid) ?? null)
        : null;
      try {
        applyParticleLook({
          system,
          emitter,
          systemPayload,
          gpu: this.gpu,
          texture,
          material,
        });
      } catch {
        this.onDiagnostic?.({
          code: "particle.apply_failed",
          message: "Particle Emitter failed to apply; slot skipped.",
          assetGuid: emitterGuid,
        });
        system.dispose(false);
        return;
      }
      systems.push(system);
    });
    if (systems.length === 0) {
      node.dispose();
      this.publishStats();
      return;
    }
    const sorting = resolveSortingLayer(
      DEFAULT_SORTING_LAYERS,
      command.sortingLayer?.trim() || "Default",
      typeof command.orderInLayer === "number" ? command.orderInLayer : 0,
    );
    for (const system of systems) {
      applySortingToParticleSystem(system, sorting);
    }
    const entry: LiveComponent = {
      actorGuid: command.actorGuid,
      componentId: command.componentId,
      slotId: command.slotId,
      systems,
      node,
      playing: false,
    };
    this.live.set(key, entry);
    if (command.play !== false) {
      this.startEntry(entry);
    }
    this.publishStats();
  }

  private setPlaying(
    command: Extract<CommandMessage, { type: "setParticlePlaying" }>,
  ): void {
    for (const entry of this.live.values()) {
      if (entry.actorGuid !== command.actorGuid) continue;
      if (
        command.componentId &&
        command.componentId !== entry.componentId
      ) {
        continue;
      }
      if (command.playing) this.startEntry(entry);
      else this.stopEntry(entry);
    }
    this.publishStats();
  }

  private startEntry(entry: LiveComponent): void {
    for (const system of entry.systems) {
      this.startWhenTextureReady(system, entry);
    }
    entry.playing = true;
  }

  private startWhenTextureReady(
    system: IParticleSystem,
    entry: LiveComponent,
  ): void {
    const begin = () => {
      if (!this.live.has(liveKey(entry.actorGuid, entry.componentId))) return;
      system.reset();
      system.start();
    };
    const texture = system.particleTexture;
    if (
      !(texture instanceof Texture) ||
      texture.isReady() ||
      !texture.url
    ) {
      begin();
      return;
    }
    texture.onLoadObservable.addOnce(() => {
      begin();
    });
  }

  private stopEntry(entry: LiveComponent): void {
    for (const system of entry.systems) {
      system.stop();
    }
    entry.playing = false;
  }

  private disposeLive(key: string): void {
    const entry = this.live.get(key);
    if (!entry) return;
    for (const system of entry.systems) {
      system.stop();
      system.dispose(false);
    }
    entry.node.dispose();
    this.live.delete(key);
  }

  private publishStats(): void {
    let playing = 0;
    let systems = 0;
    for (const entry of this.live.values()) {
      systems += entry.systems.length;
      if (entry.playing) playing += 1;
    }
    particleStats.systems = systems;
    particleStats.playing = playing;
    particleStats.gpu = this.gpu;
  }
}
