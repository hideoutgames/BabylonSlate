import {
  DEFAULT_PLAY_FRAME_CAP,
  DEFAULT_RENDER_PROJECT_SETTINGS,
  defaultExportPreset,
  type ProjectDocument,
  type Result,
} from "@haptic/core";
import { playerFilesHaveKtx2Transcoder } from "@haptic/assets";
import type { ExportArtifact } from "@haptic/exporter";
import { collectAudioReverbFlushScenes, flushAudioReverbForSave } from "../lib/audio-reverb-bake";
import { classParentLookup } from "../lib/class-asset-lookup";
import { playSceneLibraryPaths } from "../lib/plugin-ui";
import {
  assetsFromIndexed,
  collectAndExportGame,
  resolveExportPluginGraph,
} from "./export-game";
import { loadExportDocuments } from "./export-game-inputs";
import { loadPlayerDistFiles } from "./load-player-files";
import type { ProjectService } from "./project-service";

export interface ExportGameArtifactOptions {
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
  options?: ExportGameArtifactOptions,
): Promise<Result<ExportArtifact, string>> {
  const exportDocument =
    options?.projectSnapshot ?? current;
  // Export consumes persisted sources even when a tab contains unsaved edits.
  // A Scene the bake cannot read, or whose changed result it cannot save
  // (writes locked or failing), fails the export only if the game reaches it.
  const reverbScenes = await collectAudioReverbFlushScenes({
    paths: playSceneLibraryPaths(exportDocument?.scenes ?? [], projectService.registry?.list() ?? []),
    load: (path) => projectService.loadDocument("scene", path),
  });
  const reverbUnsaved = await flushAudioReverbForSave(reverbScenes.scenes);
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
  const list = await projectService.listExportAssets(
    new Set(pluginGraph.order.map((plugin) => plugin.pluginGuid)),
  );
  const playerFiles = options?.playerFiles ?? (await loadPlayerDistFiles());
  const loaded = await loadExportDocuments({
    assets: list,
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
  const startupSceneGuid =
    typeof options?.startupSceneGuid === "string" &&
    options.startupSceneGuid.trim() !== ""
      ? options.startupSceneGuid.trim()
      : (exportDocument?.settings.startupSceneGuid ?? null);
  return collectAndExportGame({
    startupSceneGuid,
    project: exportDocument?.metadata,
    projectId: projectService.guid ?? undefined,
    saveGameSettings: exportDocument?.settings.saveGame,
    defaultFontGuid: exportDocument?.settings.fonts.defaultFontGuid ?? null,
    gameInstanceClass: exportDocument?.settings.gameInstanceClass ?? null,
    audioMixerGuid: exportDocument?.settings.audio.audioMixerGuid ?? null,
    occlusionEnabled:
      exportDocument?.settings.audio.occlusionEnabled !== false,
    reverbWetScale: exportDocument?.settings.audio.reverbWetScale,
    reverbDecayScale: exportDocument?.settings.audio.reverbDecayScale,
    reverbDampingScale: exportDocument?.settings.audio.reverbDampingScale,
    alwaysPackageFolders: exportDocument?.settings.alwaysPackageFolders,
    assets: assetsFromIndexed(list),
    plugins,
    projectPluginOverrides,
    preset,
    parentOf: classParentLookup(list),
    sceneByGuid: loaded.sceneByGuid,
    graphByGuid: loaded.graphByGuid,
    payloadByGuid: loaded.payloadByGuid,
    bytesByGuid: loaded.bytesByGuid,
    fontFacetypeBytesByGuid: loaded.fontFacetypeBytesByGuid,
    areaEmissionBytesByGuid: loaded.areaEmissionBytesByGuid,
    fontMsdfJsonByGuid: loaded.fontMsdfJsonByGuid,
    fontMsdfPngByGuid: loaded.fontMsdfPngByGuid,
    navmeshByGuid: loaded.navmeshByGuid,
    audioReverbByGuid: loaded.audioReverbByGuid,
    renderSettings:
      exportDocument?.settings.render ?? DEFAULT_RENDER_PROJECT_SETTINGS,
    playFrameCap:
      exportDocument?.settings.playFrameCap ?? DEFAULT_PLAY_FRAME_CAP,
    touchMinTargetPx:
      exportDocument?.settings.touchMinTargetPx ?? 44,
    pixelsPerUnit: exportDocument?.settings.twoD.pixelsPerUnit ?? 100,
    sortingLayers: exportDocument?.settings.twoD.sortingLayers,
    pixelPerfect: exportDocument?.settings.twoD.pixelPerfect === true,
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
    tagRegistry: exportDocument?.settings.tags,
    playerFiles,
    previewBuild: options?.previewBuild,
    onPhase: options?.onPhase,
  });
}
