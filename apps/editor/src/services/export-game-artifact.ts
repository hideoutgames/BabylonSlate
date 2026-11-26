import {
  DEFAULT_PLAY_FRAME_CAP,
  DEFAULT_RENDER_PROJECT_SETTINGS,
  defaultExportPreset,
  documentKindForAssetType,
  isErr,
  nearestTextureFiltering,
  type BuildPlatform,
  type ExtensionGameLibrary,
  type ProjectDocument,
  type Result,
  type SerializedGraph,
  type SerializedScene,
} from "@haptic/core";
import { createDefaultMigrationRegistry, playerFilesHaveKtx2Transcoder, type IndexedAsset } from "@haptic/assets";
import { collectExportReachability, type AppIconImages, type ExportArtifact } from "@haptic/exporter";
import { readAppIconSource, renderAppIconImages } from "../lib/app-icon";
import { collectAudioReverbFlushScenes, flushAudioReverbForSave } from "../lib/audio-reverb-bake";
import { classParentLookup } from "../lib/class-asset-lookup";
import { playSceneLibraryPaths } from "../lib/plugin-ui";
import {
  assetsFromIndexed,
  collectAndExportGame,
  exportRootSettings,
  resolveExportPluginGraph,
} from "./export-game";
import {
  EXPORT_DATA_CATALOG_TYPES,
  EXPORT_LOAD_CONCURRENCY,
  isLightweightExportJsonType,
  loadExportDocuments,
  mapWithConcurrency,
} from "./export-game-inputs";
import { loadPlayerDistFiles } from "./load-player-files";
import type { ProjectService } from "./project-service";

const exportAssetFormats = createDefaultMigrationRegistry();

export interface ExportGameArtifactOptions {
  /** The platform the game is packaged for; Preview Build packs the web game. */
  platform: BuildPlatform;
  projectSnapshot?: ProjectDocument;
  previewBuild?: boolean;
  playerFiles?: Map<string, Uint8Array>;
  onPhase?: (phase: "Compiling" | "Writing Pack") => void;
  startupSceneGuid?: string | null;
  /** When set, overrides `playerFilesHaveKtx2Transcoder` for Texture packing. */
  transcoderAvailable?: boolean;
}

/**
 * Exports the open project as a game: `options.projectSnapshot`, else
 * `current`, with the plugins its first export preset enables.
 */
export async function exportProjectGameArtifact(
  projectService: ProjectService,
  current: ProjectDocument | null,
  options: ExportGameArtifactOptions,
): Promise<Result<ExportArtifact, string>> {
  const exportDocument =
    options.projectSnapshot ?? current;
  const preset =
    exportDocument?.settings.exportPresets[0] ?? defaultExportPreset();
  const plugins = projectService.plugins;
  const projectPluginOverrides =
    exportDocument?.settings.pluginOverrides ?? {};
  const pluginGraph = resolveExportPluginGraph(
    plugins,
    projectPluginOverrides,
    preset,
  );
  const pluginErrors = pluginGraph.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (pluginErrors.length > 0) {
    return {
      ok: false as const,
      error: pluginErrors
        .map((diagnostic) => diagnostic.message)
        .join("\n"),
    };
  }
  const pluginEnabledGuids = new Set(pluginGraph.order.map((plugin) => plugin.pluginGuid));
  const list = await projectService.listExportAssets(pluginEnabledGuids);
  const indexedAssets = assetsFromIndexed(list);
  const parentOf = classParentLookup(list);
  const startupSceneGuid =
    typeof options?.startupSceneGuid === "string" &&
    options.startupSceneGuid.trim() !== ""
      ? options.startupSceneGuid.trim()
      : (exportDocument?.settings.startupSceneGuid ?? null);
  const renderSettings =
    exportDocument?.settings.render ?? DEFAULT_RENDER_PROJECT_SETTINGS;
  const rootSettings = exportRootSettings({
    saveGameDefinitionGuid: exportDocument?.settings.saveGame.definitionGuid,
    defaultFontGuid: exportDocument?.settings.fonts.defaultFontGuid ?? null,
    gameInstanceClass: exportDocument?.settings.gameInstanceClass ?? null,
    audioMixerGuid: exportDocument?.settings.audio.audioMixerGuid ?? null,
    renderSettings,
    sceneLayerPostProcessStack: exportDocument?.settings.sceneLayerPostProcessStack,
    alwaysPackageFolders: exportDocument?.settings.alwaysPackageFolders,
  });

  // Phase 1: Reachability-first discovery. Iteratively load only lightweight
  // JSON documents for newly-discovered reachable assets (never touching
  // unreached Scenes, Textures, Models, Audio, Fonts, or binary chunks).
  const assetByGuid = new Map<string, IndexedAsset>(
    list.map((asset) => [asset.header.guid, asset]),
  );
  const preloadedJson = new Map<string, unknown>();
  const attemptedPhase1 = new Set<string>();
  const loadJsonBatch = async (assetsToRead: readonly IndexedAsset[]) => {
    await mapWithConcurrency(assetsToRead, EXPORT_LOAD_CONCURRENCY, async (asset) => {
      attemptedPhase1.add(asset.header.guid);
      try {
        exportAssetFormats.requireCurrent(asset.header.type, asset.header.version);
      } catch {
        // Phase 2 records the unsupported-format error if the asset is reached.
        return;
      }
      const kind = documentKindForAssetType(asset.header.type);
      if (!kind) return;
      try {
        const doc = await projectService.loadDocument(
          kind as Parameters<ProjectService["loadDocument"]>[0],
          asset.path,
        );
        if (doc !== undefined) preloadedJson.set(asset.header.guid, doc);
      } catch {
        // Phase 2 records the read error if the asset is reached.
      }
    });
  };
  // Preload lightweight data catalog metadata (DataDefinition/DataTree/Structure/Enum)
  // needed for both reachability expansion and script type schemas.
  await loadJsonBatch(list.filter((asset) => EXPORT_DATA_CATALOG_TYPES.has(asset.header.type)));

  let reachableGuids: Set<string> | null = null;
  for (;;) {
    const closure = collectExportReachability({
      startupSceneGuid,
      ...rootSettings,
      assets: indexedAssets,
      pluginEnabledGuids,
      parentOf,
      sceneByGuid: (guid) => {
        const asset = assetByGuid.get(guid);
        return asset?.header.type === "Scene" ? (preloadedJson.get(guid) as SerializedScene | undefined) ?? null : null;
      },
      graphByGuid: (guid) => {
        const asset = assetByGuid.get(guid);
        return asset?.header.type === "Class" ? (preloadedJson.get(guid) as SerializedGraph | undefined) ?? null : null;
      },
      payloadByGuid: (guid) => {
        const asset = assetByGuid.get(guid);
        if (!asset) return null;
        if (asset.header.type === "Texture") return asset.header.payload;
        return preloadedJson.get(guid) ?? null;
      },
    });
    if (isErr(closure)) {
      return { ok: false as const, error: closure.error };
    }
    const pendingJson: IndexedAsset[] = [];
    for (const guid of closure.value.guids) {
      if (attemptedPhase1.has(guid)) continue;
      const asset = assetByGuid.get(guid);
      if (!asset || !isLightweightExportJsonType(asset.header.type)) continue;
      pendingJson.push(asset);
    }
    if (pendingJson.length === 0) {
      reachableGuids = new Set(closure.value.guids);
      break;
    }
    await loadJsonBatch(pendingJson);
  }

  // Export consumes persisted sources even when a tab contains unsaved edits.
  // Flush audio reverb bakes only for Scenes reached by the game.
  const reachableScenePaths = new Set<string>();
  for (const guid of reachableGuids) {
    const asset = assetByGuid.get(guid);
    if (asset?.header.type === "Scene") reachableScenePaths.add(asset.path);
  }
  const reverbScenePaths = playSceneLibraryPaths(
    exportDocument?.scenes ?? [],
    projectService.registry?.list() ?? [],
  ).filter((path) => reachableScenePaths.has(path));
  const reverbScenes = await collectAudioReverbFlushScenes({
    paths: reverbScenePaths,
    load: (path) => projectService.loadDocument("scene", path),
  });
  const reverbUnsaved = await flushAudioReverbForSave(reverbScenes.scenes);

  // Packages carry the App Icon; Preview Build runs in the editor's own page and has no use for one.
  const iconGuid = options.previewBuild ? null : exportDocument?.settings.appIdentity.iconTextureGuid ?? null;
  let appIcon: AppIconImages | undefined;
  if (iconGuid) {
    try {
      appIcon = await renderAppIconImages(await readAppIconSource({
        getByGuid: (guid) => projectService.registry?.getByGuid(guid),
        readAssetChunk: (path, chunkId) => projectService.readAssetChunk(path, chunkId),
      }, iconGuid));
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  }
  let extensionLibraries: ExtensionGameLibrary[];
  try {
    extensionLibraries = await projectService.extensions.gameLibraries(
      { platform: options.platform, editor: false },
      exportDocument?.settings.extensionOverrides, exportDocument?.settings.extensionSettings);
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
  const playerFiles = options?.playerFiles ?? (await loadPlayerDistFiles());
  // Phase 2: Load only reachable assets (plus data catalog types), reusing
  // non-chunked JSON documents already read in Phase 1.
  const assetsToLoad = list.filter(
    (asset) => reachableGuids.has(asset.header.guid) || EXPORT_DATA_CATALOG_TYPES.has(asset.header.type),
  );
  const loaded = await loadExportDocuments({
    assets: assetsToLoad,
    allAssets: list,
    preloadedDocuments: preloadedJson,
    loadDocument: (kind, path) =>
      projectService.loadDocument(
        kind as Parameters<ProjectService["loadDocument"]>[0],
        path,
      ),
    loadDocumentWithChunks: (kind, path, chunks) =>
      projectService.loadDocumentWithChunks(
        kind as Parameters<ProjectService["loadDocumentWithChunks"]>[0],
        path,
        chunks,
      ),
    readAssetChunk: (path, chunkId) =>
      projectService.readAssetChunk(path, chunkId),
    transcoderAvailable:
      options?.transcoderAvailable ??
      playerFilesHaveKtx2Transcoder(playerFiles),
    audioReverbBakeFailures: new Map<string, unknown>([...reverbScenes.unreadable, ...reverbUnsaved]),
  });
  return collectAndExportGame({
    startupSceneGuid,
    project: exportDocument
      ? { ...exportDocument.metadata, buildNumber: exportDocument.settings.appIdentity.buildNumber }
      : undefined,
    projectId: projectService.guid ?? undefined,
    saveGameSettings: exportDocument?.settings.saveGame,
    defaultFontGuid: exportDocument?.settings.fonts.defaultFontGuid ?? null,
    globalFallback: exportDocument?.settings.fonts.globalFallback,
    gameInstanceClass: exportDocument?.settings.gameInstanceClass ?? null,
    audioMixerGuid: exportDocument?.settings.audio.audioMixerGuid ?? null,
    occlusionEnabled:
      exportDocument?.settings.audio.occlusionEnabled !== false,
    reverbWetScale: exportDocument?.settings.audio.reverbWetScale,
    reverbDecayScale: exportDocument?.settings.audio.reverbDecayScale,
    reverbDampingScale: exportDocument?.settings.audio.reverbDampingScale,
    alwaysPackageFolders: exportDocument?.settings.alwaysPackageFolders,
    assets: indexedAssets,
    plugins,
    projectPluginOverrides,
    preset,
    parentOf,
    sceneByGuid: loaded.sceneByGuid,
    graphByGuid: loaded.graphByGuid,
    payloadByGuid: loaded.payloadByGuid,
    bytesByGuid: loaded.bytesByGuid,
    sha256ByGuid: loaded.sha256ByGuid,
    fontFacetypeBytesByGuid: loaded.fontFacetypeBytesByGuid,
    areaEmissionBytesByGuid: loaded.areaEmissionBytesByGuid,
    fontMsdfJsonByGuid: loaded.fontMsdfJsonByGuid,
    fontMsdfPngByGuid: loaded.fontMsdfPngByGuid,
    navmeshByGuid: loaded.navmeshByGuid,
    audioReverbByGuid: loaded.audioReverbByGuid,
    componentChunksByGuid: loaded.componentChunksByGuid,
    renderSettings,
    playFrameCap:
      exportDocument?.settings.playFrameCap ?? DEFAULT_PLAY_FRAME_CAP,
    garbageCollectionIntervalTicks: exportDocument?.settings.garbageCollectionIntervalTicks,
    touchMinTargetPx:
      exportDocument?.settings.touchMinTargetPx ?? 44,
    pixelsPerUnit: exportDocument?.settings.twoD.pixelsPerUnit ?? 100,
    sortingLayers: exportDocument?.settings.twoD.sortingLayers,
    pixelPerfect: exportDocument?.settings.twoD.pixelPerfect === true,
    nearestTextures: exportDocument ? nearestTextureFiltering(exportDocument.settings.twoD) : false,
    physicsWorld:
      loaded.sceneByGuid(startupSceneGuid ?? "")?.settings.physicsWorld ===
      "2d"
        ? "2d"
        : "3d",
    collisionPresets: exportDocument?.settings.physics.collisionPresets,
    infiniteLoopDetection:
      exportDocument?.settings.infiniteLoopDetection,
    loopCount: exportDocument?.settings.loopCount,
    focusNavigation: exportDocument?.settings.focusNavigation,
    sceneLayerPostProcessStack: exportDocument?.settings.sceneLayerPostProcessStack,
    tagRegistry: exportDocument?.settings.tags,
    playerFiles,
    platform: options.platform,
    extensionLibraries,
    previewBuild: options?.previewBuild,
    onPhase: options?.onPhase,
    assertTrustGatedNodesAllowed: (findings) => projectService.extensions.assertTrustGatedNodesAllowed(findings),
    ...(appIcon ? { appIcon } : {}),
  });
}
