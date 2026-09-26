import {
  createDefaultParticleSystemPayload,
  isParticleEmitterAssetType,
  particleLibraryEmitter,
  type ParticleLibrary,
  type ParticleLibraryEmitter,
  type ParticleSystemPayload,
} from "@babylonslate/assets";

export const PREVIEW_EMITTER_GUID = "preview-em";
export const PREVIEW_SYSTEM_GUID = "preview-sys";

/** Wraps one emitter in a synthetic Preview Particle System. */
export function emitterPreviewLibrary(entry: ParticleLibraryEmitter): ParticleLibrary {
  return {
    emitters: new Map([[PREVIEW_EMITTER_GUID, entry]]),
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
    emitters: used,
    systems: new Map([[PREVIEW_SYSTEM_GUID, system]]),
  };
}

/**
 * Resolve Emitters for Particle System Preview from open tabs or document
 * chunks. Registry headers do not store the Emitter look (Material, modules).
 */
export async function loadEmittersForPreview(options: {
  system: ParticleSystemPayload;
  assets: ReadonlyArray<{
    header: { guid: string; type: string; payload?: Record<string, unknown> };
    path: string;
  }>;
  openPayloads: ReadonlyMap<string, unknown>;
  loadDocument: (
    kind: "particle-emitter",
    path: string,
  ) => Promise<unknown | null>;
}): Promise<Map<string, ParticleLibraryEmitter>> {
  const byGuid = new Map(
    options.assets
      .filter((asset) => isParticleEmitterAssetType(asset.header.type))
      .map((asset) => [asset.header.guid, asset] as const),
  );
  const emitters = new Map<string, ParticleLibraryEmitter>();
  for (const guid of options.system.emitterGuids) {
    if (emitters.has(guid)) continue;
    const asset = byGuid.get(guid);
    if (!asset) continue;
    const payload =
      options.openPayloads.get(guid) ??
      (await options.loadDocument("particle-emitter", asset.path));
    if (payload == null) continue;
    const entry = particleLibraryEmitter(asset.header.type, payload);
    if (entry) emitters.set(guid, entry);
  }
  return emitters;
}
