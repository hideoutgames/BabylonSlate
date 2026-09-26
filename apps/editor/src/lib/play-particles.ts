import { documentKindForAssetType, type AssetDocumentKind } from "@babylonslate/core";
import {
  createDefaultParticleSystemPayload,
  isParticleAssetType,
  isParticleEmitterAssetType,
  particleLibraryEmitter,
  particleLibraryFromAssets,
  type ParticleLibrary,
  type ParticleLibraryEmitter,
  type ParticleSystemPayload,
} from "@babylonslate/assets";

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
 * Basic emitters and Particle Graphs each load through their own document kind.
 */
export async function loadEmittersForPreview(options: {
  system: ParticleSystemPayload;
  assets: ReadonlyArray<{
    header: { guid: string; type: string; payload?: Record<string, unknown> };
    path: string;
  }>;
  openPayloads: ReadonlyMap<string, unknown>;
  loadDocument: (
    kind: Exclude<ParticleDocumentKind, "particle-system">,
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
    const kind = asset ? particleDocumentKind(asset.header.type) : null;
    if (!asset || !kind || kind === "particle-system") continue;
    const payload =
      options.openPayloads.get(guid) ?? (await options.loadDocument(kind, asset.path));
    if (payload == null) continue;
    const entry = particleLibraryEmitter(asset.header.type, payload);
    if (entry) emitters.set(guid, entry);
  }
  return emitters;
}

/**
 * The Play particle library: every Basic emitter, Particle Graph and Particle System
 * in the project, loaded through its own document kind (so an open tab's unsaved
 * content wins) and normalized once. A failed load falls back to the header payload.
 */
export async function loadPlayParticleLibrary(options: {
  assets: ReadonlyArray<{
    header: { guid: string; type: string; name?: string; payload?: unknown };
    path: string;
  }>;
  loadDocument: (kind: ParticleDocumentKind, path: string) => Promise<unknown | null>;
}): Promise<ParticleLibrary> {
  const loaded: Array<{ guid: string; type: string; name?: string; payload: unknown }> = [];
  for (const asset of options.assets) {
    if (!isParticleAssetType(asset.header.type)) continue;
    const kind = particleDocumentKind(asset.header.type);
    if (!kind) continue;
    const payload = (await options.loadDocument(kind, asset.path)) ?? asset.header.payload;
    loaded.push({
      guid: asset.header.guid,
      type: asset.header.type,
      name: asset.header.name,
      payload,
    });
  }
  return particleLibraryFromAssets(loaded);
}
