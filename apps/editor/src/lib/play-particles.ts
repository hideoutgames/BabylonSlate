import {
  createDefaultParticleSystemPayload,
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

export function emitterPreviewLibrary(
  emitter: ParticleEmitterPayload,
): PlayParticleLibrary {
  return {
    emitters: new Map([["preview-em", emitter]]),
    systems: new Map([
      [
        "preview-sys",
        {
          ...createDefaultParticleSystemPayload(),
          emitterGuids: ["preview-em"],
        },
      ],
    ]),
  };
}

export function systemPreviewLibrary(
  system: ParticleSystemPayload,
  emitters: ReadonlyMap<string, ParticleEmitterPayload>,
): PlayParticleLibrary {
  const used = new Map<string, ParticleEmitterPayload>();
  for (const guid of system.emitterGuids) {
    const emitter = emitters.get(guid);
    if (emitter) used.set(guid, emitter);
  }
  return {
    emitters: used,
    systems: new Map([["preview-sys", system]]),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function emittersFromRegistry(
  assets: ReadonlyArray<{
    header: { guid: string; type: string; payload?: Record<string, unknown> };
  }>,
  openPayloads: ReadonlyMap<string, unknown>,
): Map<string, ParticleEmitterPayload> {
  const emitters = new Map<string, ParticleEmitterPayload>();
  for (const asset of assets) {
    if (asset.header.type !== "ParticleEmitter") continue;
    const payload =
      openPayloads.get(asset.header.guid) ?? asset.header.payload ?? {};
    emitters.set(
      asset.header.guid,
      normalizeParticleEmitterPayload(asRecord(payload)),
    );
  }
  return emitters;
}
