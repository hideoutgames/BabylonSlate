import {
  collectExportClosure,
  exportGame,
  zipExport,
  MISSING_STARTUP_SCENE_MESSAGE,
  NAVMESH_EXPORT_TYPE,
  navmeshExportGuid,
  AUDIO_REVERB_EXPORT_TYPE,
  audioReverbExportGuid,
  FONT_FACETYPE_EXPORT_TYPE,
  FONT_MSDF_ATLAS_EXPORT_TYPE,
  FONT_MSDF_EXPORT_TYPE,
  fontFacetypeExportGuid,
  fontMsdfAtlasExportGuid,
  fontMsdfExportGuid,
  type ExportAssetBytes,
  type ExportIndexedAsset,
  type ExportArtifact,
} from "@babylonslate/exporter";
import {
  defaultExportPreset,
  type ExportPreset,
  type RenderProjectSettings,
  isErr,
  isOk,
  type Result,
  type SerializedGraph,
  type SerializedScene,
} from "@babylonslate/core";
import {
  normalizeFontPayload,
  resolvePluginEnabled,
  type IndexedAsset,
} from "@babylonslate/assets";
import {
  missingPackedMaterialTextureGuids,
  normalizeMaterialDocument,
  normalizeMaterialFunctionDocument,
  type MaterialDocument,
  type MaterialFunctionDocument,
} from "@babylonslate/shader-graph";
import type { ScriptBundleEntry } from "@babylonslate/bridge";
import {
  compileAnimGraphScripts,
  compileGraphDocuments,
  compileGraphDocumentsForExport,
} from "./script-compiler";

export { MISSING_STARTUP_SCENE_MESSAGE };

export function assetsFromIndexed(
  list: ReadonlyArray<IndexedAsset>,
): ExportIndexedAsset[] {
  return list.map((asset) => ({
    guid: asset.header.guid,
    type: asset.header.type,
    name: asset.header.name,
    path: asset.path,
    parentClass: asset.header.parentClass ?? null,
    dependencies: asset.header.dependencies ?? [],
    rootId: asset.rootId,
  }));
}

export type ExportPluginDescriptor = {
  pluginGuid: string;
  enabledByDefault: boolean;
};

export type CollectExportGameParams = {
  startupSceneGuid: string | null;
  gameInstanceClass?: string | null;
  audioMixerGuid?: string | null;
  occlusionEnabled?: boolean;
  reverbWetScale?: number;
  reverbDecayScale?: number;
  reverbDampingScale?: number;
  assets: ExportIndexedAsset[];
  plugins: readonly ExportPluginDescriptor[];
  projectPluginOverrides: Record<string, { enabled: boolean }>;
  preset?: ExportPreset;
  parentOf: (classId: string) => string | null | undefined;
  sceneByGuid: (guid: string) => SerializedScene | null;
  graphByGuid: (guid: string) => SerializedGraph | null;
  bytesByGuid: (guid: string) => Uint8Array | null;
  payloadByGuid?: (guid: string) => unknown | null;
  navmeshByGuid?: (guid: string) => Uint8Array | null;
  fontFacetypeBytesByGuid?: (guid: string) => Uint8Array | null;
  fontMsdfJsonByGuid?: (guid: string) => Uint8Array | null;
  fontMsdfPngByGuid?: (guid: string) => Uint8Array | null;
  audioReverbByGuid?: (guid: string) => Uint8Array | null;
  customResolution: RenderProjectSettings;
  playFrameCap: number;
  touchMinTargetPx?: number;
  pixelsPerUnit?: number;
  pixelPerfect?: boolean;
  physicsWorld: "2d" | "3d";
  infiniteLoopDetection?: boolean;
  loopCount?: number;
  playerFiles: Map<string, Uint8Array>;
  extraFiles?: Map<string, Uint8Array>;
  /** Preview Build keeps Development Only nodes. */
  previewBuild?: boolean;
  onPhase?: (phase: "Compiling" | "Writing Pack") => void;
};

function enabledPluginGuids(
  plugins: readonly ExportPluginDescriptor[],
  projectOverrides: Record<string, { enabled: boolean }>,
  preset: ExportPreset,
): Set<string> {
  const enabled = new Set<string>();
  for (const plugin of plugins) {
    if (
      resolvePluginEnabled(
        plugin.enabledByDefault,
        projectOverrides[plugin.pluginGuid]?.enabled,
        preset.pluginOverrides[plugin.pluginGuid]?.enabled,
      )
    ) {
      enabled.add(plugin.pluginGuid);
    }
  }
  return enabled;
}

function sceneGuidForAsset(
  guid: string,
  startupSceneGuid: string,
  assets: readonly ExportIndexedAsset[],
  sceneByGuid: (guid: string) => SerializedScene | null,
): string {
  const asset = assets.find((entry) => entry.guid === guid);
  if (asset?.type === "Scene") return guid;
  for (const candidate of assets) {
    if (candidate.type !== "Scene") continue;
    const scene = sceneByGuid(candidate.guid);
    if (!scene) continue;
    const blob = JSON.stringify(scene);
    if (blob.includes(guid)) return candidate.guid;
  }
  return startupSceneGuid;
}

function decodeJsonPayload(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function materialDocumentForExport(
  type: string,
  payload: unknown,
): MaterialDocument | MaterialFunctionDocument | null {
  if (payload == null) return null;
  if (type === "MaterialFunction") {
    return normalizeMaterialFunctionDocument(payload);
  }
  if (type === "Material") {
    return normalizeMaterialDocument(payload);
  }
  return null;
}

/** Packed Texture guids that have bytes, vs Material samples that do not. */
function packedMaterialTextureWarnings(
  assets: readonly ExportIndexedAsset[],
  closureGuids: ReadonlySet<string>,
  exportAssets: readonly ExportAssetBytes[],
  payloadByGuid?: (guid: string) => unknown | null,
): string[] {
  const packedTextureGuids = new Set<string>();
  const bytesByGuid = new Map<string, Uint8Array>();
  for (const asset of exportAssets) {
    bytesByGuid.set(asset.guid, asset.bytes);
    if (asset.type === "Texture" && asset.bytes.byteLength > 0) {
      packedTextureGuids.add(asset.guid);
    }
  }
  const documents: Array<MaterialDocument | MaterialFunctionDocument> = [];
  for (const guid of closureGuids) {
    const asset = assets.find((entry) => entry.guid === guid);
    if (
      !asset ||
      (asset.type !== "Material" && asset.type !== "MaterialFunction")
    ) {
      continue;
    }
    const packed = bytesByGuid.get(guid);
    const payload =
      payloadByGuid?.(guid) ?? (packed ? decodeJsonPayload(packed) : null);
    const document = materialDocumentForExport(asset.type, payload);
    if (document) documents.push(document);
  }
  return missingPackedMaterialTextureGuids(documents, packedTextureGuids).map(
    (guid) => `Packed Material samples Texture ${guid} with no bytes`,
  );
}

export async function collectAndExportGame(
  params: CollectExportGameParams,
): Promise<Result<ExportArtifact, string>> {
  const preset = params.preset ?? defaultExportPreset();
  const bundleDebugger = params.previewBuild === true ? true : preset.bundleDebugger;
  const mode = preset.packed === false ? "loose" : "packed";
  const pluginEnabledGuids = enabledPluginGuids(
    params.plugins,
    params.projectPluginOverrides,
    preset,
  );
  const closure = collectExportClosure({
    startupSceneGuid: params.startupSceneGuid,
    gameInstanceClass: params.gameInstanceClass,
    audioMixerGuid: params.audioMixerGuid,
    assets: params.assets,
    pluginEnabledGuids,
    parentOf: params.parentOf,
    sceneByGuid: params.sceneByGuid,
    graphByGuid: params.graphByGuid,
    payloadByGuid: params.payloadByGuid,
  });
  if (isErr(closure)) {
    return { ok: false, error: closure.error };
  }

  const startup = params.startupSceneGuid!;
  const graphDocs: Array<{
    path: string;
    content: SerializedGraph;
    parentClassId?: string | null;
  }> = [];
  const animDocs: Array<{ guid: string; path: string; document: unknown }> = [];
  const exportAssets: ExportAssetBytes[] = [];
  for (const guid of closure.value) {
    const asset = params.assets.find((entry) => entry.guid === guid);
    if (!asset) continue;
    if (asset.type === "Class" || asset.type === "Graph") {
      const graph = params.graphByGuid(guid);
      if (graph) {
        graphDocs.push({
          path: asset.name,
          content: graph,
          parentClassId: asset.parentClass,
        });
      }
    }
    if (asset.type === "AnimationGraph") {
      const payload = params.payloadByGuid?.(guid) ?? null;
      if (payload) {
        const animPath =
          asset.path && /\.anim\.(babasset|json)$/i.test(asset.path)
            ? asset.path
            : `assets/${asset.name}.anim.babasset`;
        animDocs.push({ guid, path: animPath, document: payload });
      }
    }
    const bytes = params.bytesByGuid(guid);
    if (bytes) {
      exportAssets.push({
        guid,
        type: asset.type,
        sceneGuid: sceneGuidForAsset(guid, startup, params.assets, params.sceneByGuid),
        bytes,
        name:
          asset.type === "Font"
            ? normalizeFontPayload(params.payloadByGuid?.(guid), asset.name).family
            : asset.name,
      });
    }
  }
  for (const guid of closure.value) {
    const asset = params.assets.find((entry) => entry.guid === guid);
    if (!asset || asset.type !== "Scene") continue;
    const nav = params.navmeshByGuid?.(guid);
    if (!nav || nav.byteLength === 0) continue;
    exportAssets.push({
      guid: navmeshExportGuid(guid),
      type: NAVMESH_EXPORT_TYPE,
      sceneGuid: guid,
      bytes: nav,
      encoding: "bytes",
      name: `${asset.name} NavMesh`,
    });
  }
  for (const guid of closure.value) {
    const asset = params.assets.find((entry) => entry.guid === guid);
    if (!asset || asset.type !== "Scene") continue;
    const field = params.audioReverbByGuid?.(guid);
    if (!field || field.byteLength === 0) continue;
    exportAssets.push({
      guid: audioReverbExportGuid(guid),
      type: AUDIO_REVERB_EXPORT_TYPE,
      sceneGuid: guid,
      bytes: field,
      encoding: "bytes",
      name: `${asset.name} AudioReverb`,
    });
  }
  for (const guid of closure.value) {
    const asset = params.assets.find((entry) => entry.guid === guid);
    if (!asset || asset.type !== "Font") continue;
    const facetype = params.fontFacetypeBytesByGuid?.(guid);
    if (!facetype || facetype.byteLength === 0) continue;
    exportAssets.push({
      guid: fontFacetypeExportGuid(guid),
      type: FONT_FACETYPE_EXPORT_TYPE,
      sceneGuid: sceneGuidForAsset(guid, startup, params.assets, params.sceneByGuid),
      bytes: facetype,
      encoding: "bytes",
      name: `${asset.name} Facetype`,
    });
  }
  for (const guid of closure.value) {
    const asset = params.assets.find((entry) => entry.guid === guid);
    if (!asset || asset.type !== "Font") continue;
    const json = params.fontMsdfJsonByGuid?.(guid);
    const png = params.fontMsdfPngByGuid?.(guid);
    if (!json || json.byteLength === 0 || !png || png.byteLength === 0) continue;
    const sceneGuid = sceneGuidForAsset(
      guid,
      startup,
      params.assets,
      params.sceneByGuid,
    );
    exportAssets.push({
      guid: fontMsdfExportGuid(guid),
      type: FONT_MSDF_EXPORT_TYPE,
      sceneGuid,
      bytes: json,
      encoding: "bytes",
      name: `${asset.name} MSDF`,
    });
    exportAssets.push({
      guid: fontMsdfAtlasExportGuid(guid),
      type: FONT_MSDF_ATLAS_EXPORT_TYPE,
      sceneGuid,
      bytes: png,
      encoding: "bytes",
      name: `${asset.name} MSDF Atlas`,
    });
  }

  params.onPhase?.("Compiling");
  const classScripts: ScriptBundleEntry[] = bundleDebugger
    ? compileGraphDocuments(graphDocs)
    : compileGraphDocumentsForExport(graphDocs);
  const animScripts = compileAnimGraphScripts(animDocs, {
    stripDevelopmentOnly: !bundleDebugger,
  });
  const scripts: ScriptBundleEntry[] = [...classScripts, ...animScripts];

  params.onPhase?.("Writing Pack");
  const packed = await exportGame({
    mode,
    bundleDebugger,
    startupSceneGuid: startup,
    gameInstanceClass: params.gameInstanceClass,
    audioMixerGuid: params.audioMixerGuid,
    occlusionEnabled: params.occlusionEnabled,
    reverbWetScale: params.reverbWetScale,
    reverbDecayScale: params.reverbDecayScale,
    reverbDampingScale: params.reverbDampingScale,
    customResolution: params.customResolution,
    playFrameCap: params.playFrameCap,
    touchMinTargetPx: params.touchMinTargetPx,
    pixelsPerUnit: params.pixelsPerUnit,
    pixelPerfect: params.pixelPerfect,
    physicsWorld: params.physicsWorld,
    infiniteLoopDetection: params.infiniteLoopDetection,
    loopCount: params.loopCount,
    scripts,
    assets: exportAssets,
    playerFiles: params.playerFiles,
    extraFiles: params.extraFiles,
    fileCountWarn: preset.fileCountWarn,
    fileCountFail: preset.fileCountFail,
  });
  if (isOk(packed)) {
    packed.value.warnings.push(
      ...packedMaterialTextureWarnings(
        params.assets,
        new Set(closure.value),
        exportAssets,
        params.payloadByGuid,
      ),
    );
  }
  return packed;
}

export function zipGameArtifact(artifact: ExportArtifact): Uint8Array {
  return zipExport(artifact);
}
