import { documentKindForAssetType, type AssetDocumentKind } from "@haptic/core";
import { PARTICLE_SPAWN_LIMITS, particleGraphSpawnEmitters } from "@haptic/particle-graph";
import {
  createDefaultParticleSystemPayload,
  isParticleEmitterAssetType,
  particleLibraryEmitter,
  type ParticleLibrary,
  type ParticleLibraryEmitter,
  type ParticleSystemPayload,
} from "@haptic/assets";

export const PREVIEW_EMITTER_GUID = "preview-em";
export const PREVIEW_SYSTEM_GUID = "preview-sys";

/** Document kinds of the particle asset types (Basic emitter, Particle Graph, Particle System). */
export type ParticleDocumentKind = Extract<
  AssetDocumentKind,
  "particle-emitter" | "particle-graph" | "particle-system"
>;

/** Each particle asset type loads (and finds its open tab) under its own document kind. */
function particleDocumentKind(type: string): ParticleDocumentKind | null {
  const kind = documentKindForAssetType(type);
  return kind === "particle-emitter" || kind === "particle-graph" || kind === "particle-system"
    ? kind
    : null;
}

/**
 * `selected` plus the emitters their Spawn Emitters play, found in `available`, down to
 * `PARTICLE_SPAWN_LIMITS.depth` levels (deeper spawns never play).
 */
function withSpawnedEmitters(
  selected: Map<string, ParticleLibraryEmitter>,
  available: ReadonlyMap<string, ParticleLibraryEmitter>,
): Map<string, ParticleLibraryEmitter> {
  let level = [...selected.values()];
  for (let depth = 0; depth < PARTICLE_SPAWN_LIMITS.depth && level.length; depth += 1) {
    const next: ParticleLibraryEmitter[] = [];
    for (const entry of level) {
      if (entry.kind !== "graph") continue;
      for (const guid of particleGraphSpawnEmitters(entry.document.nodes)) {
        const spawned = available.get(guid);
        if (!spawned || selected.has(guid)) continue;
        selected.set(guid, spawned);
        next.push(spawned);
      }
    }
    level = next;
  }
  return selected;
}

/** Wraps one emitter in a synthetic Preview Particle System, with the emitters it spawns from `spawned`. */
export function emitterPreviewLibrary(
  entry: ParticleLibraryEmitter,
  spawned: ReadonlyMap<string, ParticleLibraryEmitter> = new Map(),
): ParticleLibrary {
  return {
    emitters: withSpawnedEmitters(new Map([[PREVIEW_EMITTER_GUID, entry]]), spawned),
    systems: new Map([
      [
        PREVIEW_SYSTEM_GUID,
        {
          ...createDefaultParticleSystemPayload(),
          emitterGuids: [PREVIEW_EMITTER_GUID],
        },
      ],
    ]),
  };
}

export function systemPreviewLibrary(
  system: ParticleSystemPayload,
  emitters: ReadonlyMap<string, ParticleLibraryEmitter>,
): ParticleLibrary {
  const used = new Map<string, ParticleLibraryEmitter>();
  for (const guid of system.emitterGuids) {
    const emitter = emitters.get(guid);
    if (emitter) used.set(guid, emitter);
  }
  return {
    emitters: withSpawnedEmitters(used, emitters),
    systems: new Map([[PREVIEW_SYSTEM_GUID, system]]),
  };
}

/**
 * Resolve Emitters for Particle System Preview from open tabs or document
 * chunks. Registry headers do not store the Emitter look (Material, modules).
 * Basic emitters and Particle Graphs each load through their own document kind.
 */
export async function loadEmittersForPreview(options: EmitterDocumentSources & {
  system: ParticleSystemPayload;
}): Promise<Map<string, ParticleLibraryEmitter>> {
  const emitters = new Map<string, ParticleLibraryEmitter>();
  await loadEmitterDocuments(options.system.emitterGuids, options, emitters);
  for (const [guid, entry] of await loadSpawnedEmittersForPreview([...emitters.values()], options, emitters)) emitters.set(guid, entry);
  return emitters;
}

/** Where preview emitter documents come from: registry assets, open tabs, then document chunks. */
export type EmitterDocumentSources = {
  assets: ReadonlyArray<{
    header: { guid: string; type: string; payload?: Record<string, unknown> };
    path: string;
  }>;
  openPayloads: ReadonlyMap<string, unknown>;
  loadDocument: (
    kind: Exclude<ParticleDocumentKind, "particle-system">,
    path: string,
  ) => Promise<unknown | null>;
};

/** Loads `guids` into `into`; guids it already holds, unknown assets and missing documents are skipped. */
async function loadEmitterDocuments(
  guids: Iterable<string>,
  sources: EmitterDocumentSources,
  into: Map<string, ParticleLibraryEmitter>,
): Promise<void> {
  const byGuid = new Map(
    sources.assets
      .filter((asset) => isParticleEmitterAssetType(asset.header.type))
      .map((asset) => [asset.header.guid, asset] as const),
  );
  for (const guid of guids) {
    if (into.has(guid)) continue;
    const asset = byGuid.get(guid);
    const kind = asset ? particleDocumentKind(asset.header.type) : null;
    if (!asset || !kind || kind === "particle-system") continue;
    const payload =
      sources.openPayloads.get(guid) ?? (await sources.loadDocument(kind, asset.path));
    if (payload == null) continue;
    const entry = particleLibraryEmitter(asset.header.type, payload);
    if (entry) into.set(guid, entry);
  }
}

/**
 * The emitters `roots`' Spawn Emitters play, loaded down to `PARTICLE_SPAWN_LIMITS.depth` levels
 * (deeper spawns never play). `known` holds emitters already loaded, which are reused.
 */
export async function loadSpawnedEmittersForPreview(
  roots: readonly ParticleLibraryEmitter[],
  sources: EmitterDocumentSources,
  known: ReadonlyMap<string, ParticleLibraryEmitter> = new Map(),
): Promise<Map<string, ParticleLibraryEmitter>> {
  const loaded = new Map(known);
  const spawned = new Map<string, ParticleLibraryEmitter>();
  let level = [...roots];
  for (let depth = 0; depth < PARTICLE_SPAWN_LIMITS.depth && level.length; depth += 1) {
    const guids = level.flatMap((entry) => entry.kind === "graph" ? particleGraphSpawnEmitters(entry.document.nodes) : [])
      .filter((guid) => !spawned.has(guid));
    await loadEmitterDocuments(guids, sources, loaded);
    level = [];
    for (const guid of guids) {
      const entry = loaded.get(guid);
      if (!entry || spawned.has(guid)) continue;
      spawned.set(guid, entry);
      level.push(entry);
    }
  }
  return spawned;
}
