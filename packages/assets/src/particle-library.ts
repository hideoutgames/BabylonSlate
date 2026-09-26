/**
 * The one particle library shape shared by editor Play, the emitter/system previews,
 * `@babylonslate/render` and the exported player. Emitter entries are tagged by kind so
 * a Particle System can mix Basic emitters and Particle Graphs per slot.
 */
import {
  normalizeParticleGraphDocument,
  particleGraphCompileKey,
  type ParticleGraphDocument,
} from "@babylonslate/particle-graph";
import { stableStringify } from "./bytes";
import {
  normalizeParticleEmitterPayload,
  type ParticleEmitterPayload,
} from "./particle-basic-emitter";
import {
  PARTICLE_ASSET_TYPES,
  normalizeParticleSystemPayload,
  type ParticleAssetType,
  type ParticleSystemPayload,
} from "./particle-payload";

export const PARTICLE_EMITTER_ASSET_TYPES = ["ParticleEmitter", "ParticleGraph"] as const;
export type ParticleEmitterAssetType = (typeof PARTICLE_EMITTER_ASSET_TYPES)[number];

export type ParticleLibraryEmitter =
  | { kind: "basic"; payload: ParticleEmitterPayload }
  | { kind: "graph"; document: ParticleGraphDocument };

export type ParticleLibrary = {
  emitters: ReadonlyMap<string, ParticleLibraryEmitter>;
  systems: ReadonlyMap<string, ParticleSystemPayload>;
};

export function isParticleAssetType(type: string): type is ParticleAssetType {
  return (PARTICLE_ASSET_TYPES as readonly string[]).includes(type);
}

export function isParticleEmitterAssetType(
  type: string,
): type is ParticleEmitterAssetType {
  return (PARTICLE_EMITTER_ASSET_TYPES as readonly string[]).includes(type);
}

export function emptyParticleLibrary(): ParticleLibrary {
  return { emitters: new Map(), systems: new Map() };
}

/** Normalized library entry for an emitter asset, or null for other asset types. */
export function particleLibraryEmitter(
  type: string,
  payload: unknown,
): ParticleLibraryEmitter | null {
  if (type === "ParticleEmitter") {
    return { kind: "basic", payload: normalizeParticleEmitterPayload(payload) };
  }
  if (type === "ParticleGraph") {
    return { kind: "graph", document: normalizeParticleGraphDocument(payload) };
  }
  return null;
}

/** One normalizer for every read site (no migration runs at header v1). Other asset types are ignored. */
export function particleLibraryFromAssets(
  assets: Iterable<{ guid: string; type: string; name?: string; payload: unknown }>,
): ParticleLibrary {
  const emitters = new Map<string, ParticleLibraryEmitter>();
  const systems = new Map<string, ParticleSystemPayload>();
  for (const asset of assets) {
    if (asset.type === "ParticleSystem") {
      systems.set(asset.guid, normalizeParticleSystemPayload(asset.payload));
      continue;
    }
    const emitter = particleLibraryEmitter(asset.type, asset.payload);
    if (emitter) emitters.set(asset.guid, emitter);
  }
  return { emitters, systems };
}

export function particleEmitterMaterialGuid(
  entry: ParticleLibraryEmitter,
): string | null {
  return entry.kind === "graph"
    ? entry.document.materialGuid
    : entry.payload.render.materialGuid;
}

/** Unique Material guids in emitter insertion order. */
export function particleLibraryMaterialGuids(library: ParticleLibrary): string[] {
  const guids = new Set<string>();
  for (const entry of library.emitters.values()) {
    const guid = particleEmitterMaterialGuid(entry);
    if (guid) guids.add(guid);
  }
  return [...guids];
}

/**
 * Content key of one emitter entry. A Particle Graph keys on its position-free
 * compile key plus its Material, so dragging a node never changes it while any
 * simulation or Material edit does.
 */
export function particleLibraryEmitterKey(entry: ParticleLibraryEmitter): string {
  if (entry.kind === "graph") {
    return stableStringify({
      kind: "graph",
      compileKey: particleGraphCompileKey(entry.document),
      materialGuid: entry.document.materialGuid,
    });
  }
  return stableStringify(entry);
}

/** Order-independent key of the library content. */
export function particleLibraryCompileKey(library: ParticleLibrary): string {
  const sorted = <T>(map: ReadonlyMap<string, T>): Array<[string, T]> =>
    [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return stableStringify({
    emitters: sorted(library.emitters).map(
      ([guid, entry]) => [guid, particleLibraryEmitterKey(entry)] as const,
    ),
    systems: sorted(library.systems),
  });
}
