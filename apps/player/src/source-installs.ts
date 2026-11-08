import { fontMsdfAtlasExportGuid, type GameManifest, type GameSourceContent } from "@haptic/exporter";
import { installModelSources, installTextureBytes } from "@haptic/render";

type InstallCache = Map<string, { revision: string; blob: Blob }>;

/**
 * The boot's installed render sources. Installing copies an asset's bytes into an immutable Blob,
 * so each Texture, Model source and MSDF atlas installs once per boot: keyed by guid and its catalog
 * revision (never by array identity), and reused by `createEngine` and every `acquireSceneSources`.
 * A Texture's or atlas's catalog revision is the SHA-256 the artifact verified for its bytes, so they
 * are not hashed again. Installs of sources the game no longer holds are forgotten at the next install.
 */
export function createPlayerSourceInstalls(game: Pick<GameSourceContent, "textureBytes" | "modelBytes" | "fontMsdfPng"> & { manifest: GameManifest }) {
  const revisions = new Map(game.manifest.assets.flatMap((entry) => entry.revision ? [[entry.guid, entry.revision] as const] : []));
  const textures: InstallCache = new Map();
  const models: InstallCache = new Map();
  const atlases: InstallCache = new Map();
  const prune = () => {
    for (const [cache, held] of [[textures, game.textureBytes], [models, game.modelBytes], [atlases, game.fontMsdfPng]] as const) {
      for (const guid of cache.keys()) if (!held.has(guid)) cache.delete(guid);
    }
  };
  const install = (
    cache: InstallCache,
    sources: ReadonlyMap<string, Uint8Array>,
    revisionOf: (guid: string) => string | undefined,
    installMissing: (missing: ReadonlyMap<string, Uint8Array>) => ReadonlyMap<string, Blob> | undefined,
  ): Map<string, Blob> => {
    prune();
    const missing = new Map<string, Uint8Array>();
    for (const [guid, bytes] of sources) {
      const revision = revisionOf(guid);
      if (!revision || cache.get(guid)?.revision !== revision) missing.set(guid, bytes);
    }
    const installed = installMissing(missing) ?? new Map<string, Blob>();
    for (const [guid, blob] of installed) {
      const revision = revisionOf(guid);
      if (revision) cache.set(guid, { revision, blob });
    }
    return new Map([...sources.keys()].map((guid) => [guid, installed.get(guid) ?? cache.get(guid)!.blob]));
  };
  const revisionOf = (guid: string) => revisions.get(guid);
  // An atlas is its own sidecar entry's whole payload, keyed by its Font.
  const atlasRevision = (guid: string) => revisions.get(fontMsdfAtlasExportGuid(guid));
  return {
    // A Texture is its entry's whole payload, so the revision is its bytes' SHA-256.
    textures: (sources: ReadonlyMap<string, Uint8Array>) =>
      install(textures, sources, revisionOf, (missing) => installTextureBytes(missing, revisionOf)),
    // A Model's source is part of its packed payload: the revision keys it, but its bytes are hashed.
    models: (sources: ReadonlyMap<string, Uint8Array>) =>
      install(models, sources, revisionOf, (missing) => installModelSources({ modelBytes: missing })),
    msdfAtlases: (sources: ReadonlyMap<string, Uint8Array>) =>
      install(atlases, sources, atlasRevision, (missing) => installTextureBytes(missing, atlasRevision)),
  };
}
