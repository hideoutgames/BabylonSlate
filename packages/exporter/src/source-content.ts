import type { CollisionTriangleMesh, SerializedScene, SerializedSceneLayer } from "@babylonslate/core";
import type { ScriptBundleEntry } from "@babylonslate/bridge";
import type { AreaEmissionPixels, AudioPayload, ModelPayload } from "@babylonslate/assets";
import type { GameManifest } from "./types";

/** Prepared sources shared by Play, Preview Build, and the standalone player. */
export type GameSourceContent = {
  decodedPayloads?: ReadonlyMap<string, unknown>;
  audioSourceRevisions?: ReadonlyMap<string, string>;
  /** Cooked Complex Collision meshes; omitted means "cook the scanned Models from `modelBytes`". */
  complexMeshes?: ReadonlyMap<string, CollisionTriangleMesh>;
  modelAnimationDurations?: ReadonlyMap<string, ReadonlyMap<string, number | undefined>>;
  manifest: GameManifest;
  scripts: ScriptBundleEntry[];
  scenes: Map<string, SerializedScene>;
  sceneLayers: Map<string, SerializedSceneLayer>;
  textureBytes: Map<string, Uint8Array>;
  areaEmissions: Map<string, AreaEmissionPixels>;
  modelBytes: Map<string, Uint8Array>;
  modelPayloads: Map<string, ModelPayload>;
  fontBytes: Map<string, Uint8Array>;
  fontFacetypeBytes: Map<string, Uint8Array>;
  fontMsdfJson: Map<string, Uint8Array>;
  fontMsdfPng: Map<string, Uint8Array>;
  fontFamilies: Map<string, string>;
  audioBytes: Map<string, Uint8Array>;
  audioPayloads: Map<string, AudioPayload>;
  payloads: Map<string, Uint8Array>;
  navmeshBytes: Map<string, Uint8Array>;
  audioReverbBytes: Map<string, Uint8Array>;
};

/** Required edges only; deferred references stay in the catalog for later use. */
export function requiredGameAssets(manifest: GameManifest, roots: readonly string[]): Set<string> {
  const entries = new Map(manifest.assets.map(entry => [entry.guid, entry]));
  const result = new Set<string>();
  const visit = (guid: string) => {
    if (result.has(guid)) return;
    result.add(guid);
    for (const dependency of entries.get(guid)?.requiredDependencies ?? []) visit(dependency);
  };
  for (const root of roots) visit(root);
  return result;
}

/** Snapshot one owner's source maps, including sidecars keyed by their owner. */
export function gameSourceSubset(game: GameSourceContent, ids: ReadonlySet<string>): GameSourceContent {
  const keys = new Set(ids);
  for (const id of ids) {
    const owner = game.manifest.assets.find(entry => entry.guid === id)?.ownerGuid;
    const colon = id.indexOf(":");
    if (owner) keys.add(owner);
    else if (colon >= 0) keys.add(id.slice(colon + 1));
  }
  const select = <T>(map: ReadonlyMap<string, T>): Map<string, T> => new Map([...map].filter(([guid]) => keys.has(guid)));
  return {
    ...game,
    scripts: game.scripts.filter(script => keys.has(script.assetGuid)),
    ...(game.audioSourceRevisions ? { audioSourceRevisions: select(game.audioSourceRevisions) } : {}),
    ...(game.decodedPayloads ? { decodedPayloads: select(game.decodedPayloads) } : {}),
    ...(game.complexMeshes ? { complexMeshes: select(game.complexMeshes) } : {}),
    ...(game.modelAnimationDurations ? { modelAnimationDurations: select(game.modelAnimationDurations) } : {}),
    scenes: select(game.scenes), sceneLayers: select(game.sceneLayers),
    textureBytes: select(game.textureBytes), areaEmissions: select(game.areaEmissions),
    modelBytes: select(game.modelBytes), modelPayloads: select(game.modelPayloads),
    fontBytes: select(game.fontBytes), fontFamilies: select(game.fontFamilies),
    fontFacetypeBytes: select(game.fontFacetypeBytes), fontMsdfJson: select(game.fontMsdfJson), fontMsdfPng: select(game.fontMsdfPng),
    audioBytes: select(game.audioBytes), audioPayloads: select(game.audioPayloads),
    payloads: select(game.payloads), navmeshBytes: select(game.navmeshBytes), audioReverbBytes: select(game.audioReverbBytes),
  };
}
