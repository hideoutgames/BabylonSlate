import {
  createDefaultParticleSystemPayload,
  isParticleEmitterAssetType,
  particleEmitterChangeTier,
  particleLibraryEmitter,
  stableStringify,
  type ParticleEmitterChangeTier,
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

const TIER_ORDER: readonly ParticleEmitterChangeTier[] = [
  "none",
  "live",
  "respawn",
  "rebuild",
];

/**
 * How a running preview must apply `next` over `applied`: the worst emitter tier,
 * or `rebuild` when a System or an emitter slot itself changed. The preview applies
 * `live` edits at once and waits for a pause in editing before heavier ones.
 */
export function particleLibraryChangeTier(
  applied: ParticleLibrary,
  next: ParticleLibrary,
): ParticleEmitterChangeTier {
  const systemGuids = new Set([...applied.systems.keys(), ...next.systems.keys()]);
  for (const guid of systemGuids) {
    if (
      stableStringify(applied.systems.get(guid) ?? null) !==
      stableStringify(next.systems.get(guid) ?? null)
    ) {
      return "rebuild";
    }
  }
  let tier: ParticleEmitterChangeTier = "none";
  const emitterGuids = new Set([...applied.emitters.keys(), ...next.emitters.keys()]);
  for (const guid of emitterGuids) {
    const before = applied.emitters.get(guid);
    const after = next.emitters.get(guid);
    if (!before || !after || before.kind !== after.kind) return "rebuild";
    const emitterTier = particleEmitterChangeTier(before.payload, after.payload);
    if (TIER_ORDER.indexOf(emitterTier) > TIER_ORDER.indexOf(tier)) tier = emitterTier;
  }
  return tier;
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
