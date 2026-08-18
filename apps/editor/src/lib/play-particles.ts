import {
  normalizeParticleEmitterPayload,
  normalizeParticleSystemPayload,
  type ParticleEmitterPayload,
  type ParticleSystemPayload,
} from "@babylonslate/assets";

export type PlayParticleLibrary = {
  emitters: Map<string, ParticleEmitterPayload>;
  systems: Map<string, ParticleSystemPayload>;
};

export function emptyPlayParticleLibrary(): PlayParticleLibrary {
  return {
    emitters: new Map(),
    systems: new Map(),
  };
}

/** Build a Play particle library from registry/open-document payloads. */
export function playParticleLibraryFromAssets(options: {
  assets: ReadonlyArray<{ guid: string; type: string; payload: unknown }>;
}): PlayParticleLibrary {
  const library = emptyPlayParticleLibrary();
  for (const asset of options.assets) {
    if (asset.type === "ParticleEmitter") {
      library.emitters.set(
        asset.guid,
        normalizeParticleEmitterPayload(asset.payload),
      );
    } else if (asset.type === "ParticleSystem") {
      library.systems.set(
        asset.guid,
        normalizeParticleSystemPayload(asset.payload),
      );
    }
  }
  return library;
}

export function particleTextureGuidsFromLibrary(
  library: PlayParticleLibrary,
): string[] {
  const guids: string[] = [];
  const seen = new Set<string>();
  for (const emitter of library.emitters.values()) {
    if (!emitter.textureGuid || seen.has(emitter.textureGuid)) continue;
    seen.add(emitter.textureGuid);
    guids.push(emitter.textureGuid);
  }
  return guids;
}

export function particleMaterialGuidsFromLibrary(
  library: PlayParticleLibrary,
): string[] {
  const guids: string[] = [];
  const seen = new Set<string>();
  for (const emitter of library.emitters.values()) {
    if (!emitter.materialGuid || seen.has(emitter.materialGuid)) continue;
    seen.add(emitter.materialGuid);
    guids.push(emitter.materialGuid);
  }
  return guids;
}
