import { validateSaveGameDefinition, type SaveGameConfiguration } from "@babylonslate/core";
import { subsystemBaseClassIdOf } from "@babylonslate/object-model";
import { dataTypeSchemas } from "@babylonslate/scripting";
import type { DataAssetCatalogEntry } from "@babylonslate/core";
import { areaEmissionTextureGuids, buildDataTreeIndex, classIdForAssetPath, isDataTreeAsset, isInputAssetType, normalizeInputAssetPayload, renderEffectsAssetGuids } from "@babylonslate/core";
import {
  collectExportReachability,
  exportGame,
  zipExport,
  MISSING_STARTUP_SCENE_MESSAGE,
  NAVMESH_EXPORT_TYPE,
  navmeshExportGuid,
  AUDIO_REVERB_EXPORT_TYPE,
  audioReverbExportGuid,
  FONT_FACETYPE_EXPORT_TYPE,
  AREA_EMISSION_EXPORT_TYPE,
  areaEmissionExportGuid,
  FONT_MSDF_ATLAS_EXPORT_TYPE,
  FONT_MSDF_EXPORT_TYPE,
  fontFacetypeExportGuid,
  fontMsdfAtlasExportGuid,
  fontMsdfExportGuid,
  type ExportAssetBytes,
  type ExportIndexedAsset,
  type ExportRootInput,
  type ExportArtifact,
} from "@babylonslate/exporter";
import {
  defaultExportPreset,
  type ExportPreset,
  type PluginEnableOverride,
  type RenderProjectSettings,
  isErr,
  isOk,
  type Result,
  type SerializedGraph,
  type SerializedScene,
  type TagRegistry,
} from "@babylonslate/core";
import {
  normalizeFontPayload,
  resolveAssetCatalogDependencies,
  resolvePluginEnabled,
  resolvePluginGraph,
  type IndexedAsset,
  type PluginGraphInput,
} from "@babylonslate/assets";
import {
  missingPackedMaterialTextureGuids,
  normalizeMaterialDocument,
  normalizeMaterialFunctionDocument,
  type MaterialDocument,
  type MaterialFunctionDocument,
} from "@babylonslate/shader-graph";
import type { ScriptBundleEntry } from "@babylonslate/bridge";
import { AudioReverbBakeUnsavedError } from "../lib/audio-reverb-bake";

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
    dependencies: resolveAssetCatalogDependencies(asset.header, list),
    requiredDependencies: asset.header.requiredDependencies ? resolveAssetCatalogDependencies(asset.header, list, true) : undefined,
    requiredVariableNames: asset.header.requiredVariableNames,
    classReferences: asset.header.classReferences,
    requiredClassReferences: asset.header.requiredClassReferences,
    consoleCommand: asset.header.consoleCommand,
    dependencyMetadataVersion: asset.header.dependencyMetadataVersion,
    rootId: asset.rootId,
  }));
}

/**
 * The roots that the project settings add to a packaged set, shared by game
 * exports and the asset catalog Editor Play lists.
 */
export function exportRootSettings(settings: {
  saveGameDefinitionGuid?: string | null;
  defaultFontGuid?: string | null;
  gameInstanceClass?: string | null;
  audioMixerGuid?: string | null;
  renderSettings: RenderProjectSettings;
  alwaysPackageFolders?: readonly string[];
}): Pick<ExportRootInput, "saveGameDefinitionGuid" | "gameInstanceClass" | "audioMixerGuid" | "renderAssetGuids" | "alwaysPackageFolders"> {
  return {
    saveGameDefinitionGuid: settings.saveGameDefinitionGuid,
    gameInstanceClass: settings.gameInstanceClass,
    audioMixerGuid: settings.audioMixerGuid,
    renderAssetGuids: [...renderEffectsAssetGuids(settings.renderSettings.effects), ...(settings.defaultFontGuid ? [settings.defaultFontGuid] : [])],
    alwaysPackageFolders: settings.alwaysPackageFolders,
  };
}

export type ExportPluginDescriptor = PluginGraphInput;

export type CollectExportGameParams = {
  projectId?: string;
  saveGameSettings?: import("@babylonslate/core").SaveGameProjectSettings;
  project?: { name: string; version: string };
  startupSceneGuid: string | null;
  gameInstanceClass?: string | null;
  audioMixerGuid?: string | null;
  occlusionEnabled?: boolean;
  reverbWetScale?: number;
  reverbDecayScale?: number;
  reverbDampingScale?: number;
  /** Project Always Package Folders: their assets ship even when unreferenced. */
  alwaysPackageFolders?: readonly string[];
  assets: ExportIndexedAsset[];
  plugins: readonly ExportPluginDescriptor[];
  projectPluginOverrides: Record<string, PluginEnableOverride>;
  preset?: ExportPreset;
  parentOf: (classId: string) => string | null | undefined;
  sceneByGuid: (guid: string) => SerializedScene | null;
  graphByGuid: (guid: string) => SerializedGraph | null;
  /** Throws for an asset whose bytes failed to load; the export then fails. */
  bytesByGuid: (guid: string) => Uint8Array | null;
  payloadByGuid?: (guid: string) => unknown | null;
  navmeshByGuid?: (guid: string) => Uint8Array | null;
  fontFacetypeBytesByGuid?: (guid: string) => Uint8Array | null;
  areaEmissionBytesByGuid?: (guid: string) => Uint8Array | null;
  fontMsdfJsonByGuid?: (guid: string) => Uint8Array | null;
  fontMsdfPngByGuid?: (guid: string) => Uint8Array | null;
  /** Throws for a Scene whose reverb could not be baked or saved; a reached one fails the export. */
  audioReverbByGuid?: (guid: string) => Uint8Array | null;
  renderSettings: RenderProjectSettings;
  defaultFontGuid?: string | null;
  playFrameCap: number;
  touchMinTargetPx?: number;
  pixelsPerUnit?: number;
  sortingLayers?: readonly string[];
  pixelPerfect?: boolean;
  physicsWorld: "2d" | "3d";
  infiniteLoopDetection?: boolean;
  loopCount?: number;
  focusNavigation?: import("@babylonslate/core").FocusNavigationSettings;
  tagRegistry?: TagRegistry;
  playerFiles: Map<string, Uint8Array>;
  /** Preview Build keeps Development Only nodes. */
  previewBuild?: boolean;
  onPhase?: (phase: "Compiling" | "Writing Pack") => void;
};

export function resolveExportPluginGraph(
  plugins: readonly ExportPluginDescriptor[],
  projectOverrides: Record<string, PluginEnableOverride>,
  preset: ExportPreset,
): ReturnType<typeof resolvePluginGraph> {
  const enabled = plugins.filter((plugin) =>
    resolvePluginEnabled(
      plugin.settings.enabledByDefault,
      projectOverrides[plugin.pluginGuid]?.enabled,
      preset.pluginOverrides[plugin.pluginGuid]?.enabled,
    ),
  );
  const graph = resolvePluginGraph(enabled);
  const name = (guid: string | undefined) =>
    plugins.find((plugin) => plugin.pluginGuid === guid)?.settings
      .displayName ??
    guid ??
    "Plugin";
  return {
    order: graph.order,
    diagnostics: graph.diagnostics.map((diagnostic) => {
      const plugin = name(diagnostic.pluginGuid);
      const dependency = name(diagnostic.dependencyGuid);
      let message: string;
      switch (diagnostic.code) {
        case "plugin.missing":
          message = `Enable or install "${dependency}", required by "${plugin}", or disable "${plugin}" in the export preset.`;
          break;
        case "plugin.unsatisfiable":
          message = `"${plugin}" recorded "${dependency}" ${diagnostic.recordedVersion || "Unknown"} (installed ${diagnostic.foundVersion}). Compatibility has not been verified.`;
          break;
        case "plugin.engine_unsatisfiable":
          message = `"${plugin}" was created with engine ${diagnostic.recordedVersion || "Unknown"} (current ${diagnostic.foundVersion}). Compatibility has not been verified.`;
          break;
        case "plugin.dependency_blocked":
          message = `"${plugin}" depends on "${dependency}". Resolve its plugin errors or disable "${plugin}" in the export preset.`;
          break;
        case "plugin.cycle":
          message = `Resolve the plugin dependency cycle: ${(diagnostic.plugins ?? []).map(name).join(" → ")}.`;
          break;
      }
      return { ...diagnostic, message };
    }),
  };
}

function packSceneGuidForAsset(
  guid: string,
  startupSceneGuid: string,
  reachabilityByScene: ReadonlyMap<string, ReadonlySet<string>>,
): string {
  if (reachabilityByScene.get(startupSceneGuid)?.has(guid))
    return startupSceneGuid;
  // Shared non-boot dependencies live with the lexicographically first scene.
  return (
    [...reachabilityByScene]
      .filter(([, guids]) => guids.has(guid))
      .map(([sceneGuid]) => sceneGuid)
      .sort()[0] ?? startupSceneGuid
  );
}

function decodeJsonPayload(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function texturePixelSizeFromPayload(
  payload: unknown,
): { width: number; height: number } | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as { width?: unknown; height?: unknown };
  const width = Number(record.width);
  const height = Number(record.height);
  if (!(width > 0) || !(height > 0)) return null;
  return { width, height };
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
  for (const asset of exportAssets) {
    if (asset.type !== "RenderTargetTexture") continue;
    const payload = payloadByGuid?.(asset.guid) ?? decodeJsonPayload(asset.bytes);
    const targetGuid = payload && typeof payload === "object" ? (payload as Record<string, unknown>).renderTargetGuid : null;
    if (typeof targetGuid === "string" && exportAssets.some((entry) => entry.guid === targetGuid && entry.type === "RenderTarget" && entry.bytes.byteLength > 0)) packedTextureGuids.add(asset.guid);
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
  const bundleDebugger =
    params.previewBuild === true ? true : preset.bundleDebugger;
  const pluginGraph = resolveExportPluginGraph(
    params.plugins,
    params.projectPluginOverrides,
    preset,
  );
  const pluginErrors = pluginGraph.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (pluginErrors.length > 0) {
    return { ok: false, error: pluginErrors.map((diagnostic) => diagnostic.message).join("\n") };
  }
  const pluginEnabledGuids = new Set(pluginGraph.order.map((plugin) => plugin.pluginGuid));
  const closure = collectExportReachability({
    startupSceneGuid: params.startupSceneGuid,
    ...exportRootSettings({
      saveGameDefinitionGuid: params.saveGameSettings?.definitionGuid,
      defaultFontGuid: params.defaultFontGuid,
      gameInstanceClass: params.gameInstanceClass,
      audioMixerGuid: params.audioMixerGuid,
      renderSettings: params.renderSettings,
      alwaysPackageFolders: params.alwaysPackageFolders,
    }),
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
    guid: string;
    path: string;
    content: SerializedGraph;
    parentClassId?: string | null;
  }> = [];
  const animDocs: Array<{ guid: string; name: string; document: unknown }> = [];
  const exportAssets: ExportAssetBytes[] = [];
  const subsystemHierarchy = { ancestry(classId: string) { const result: string[] = []; const seen = new Set<string>(); let current: string | null | undefined = classId; while (current && !seen.has(current)) { seen.add(current); result.push(current); current = params.parentOf(current); } return result; } };
  const requiredEmissions = new Set<string>();
  for (const guid of closure.value.guids) {
    const asset = params.assets.find((entry) => entry.guid === guid);
    const document = asset?.type === "Scene" ? params.sceneByGuid(guid) : asset?.type === "Class" ? params.graphByGuid(guid) : params.payloadByGuid?.(guid);
    for (const texture of areaEmissionTextureGuids(document)) requiredEmissions.add(texture);
  }
  for (const guid of requiredEmissions) {
    try {
      if (!params.areaEmissionBytesByGuid?.(guid)) return { ok: false, error: `Texture ${guid} needs Prepare Emission before export. Open the Texture asset and prepare its Area Light Emission.` };
    } catch (error) { return { ok: false, error: `Area emission ${guid}: ${String(error)}` }; }
  }
  for (const guid of closure.value.guids) {
    const asset = params.assets.find((entry) => entry.guid === guid);
    if (!asset) continue;
    if (asset.type === "Class") {
      const graph = params.graphByGuid(guid);
      if (graph) {
        graphDocs.push({
          guid,
          // The class id comes from the file path, as in Play and the runtime catalog.
          path: asset.path ?? asset.name,
          content: graph,
          parentClassId: asset.parentClass,
        });
      }
    }
    if (asset.type === "AnimationGraph") {
      const payload = params.payloadByGuid?.(guid) ?? null;
      if (payload) animDocs.push({ guid, name: asset.name, document: payload });
    }
    let bytes: Uint8Array | null;
    try {
      bytes = params.bytesByGuid(guid);
    } catch (error) {
      return { ok: false, error: `${asset.name} could not be read for export: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (asset.type === "Texture") {
      // Required emissions were checked above; a stale emission no area light
      // in the closure uses is left out rather than failing the export.
      let emission: Uint8Array | null | undefined;
      try {
        emission = params.areaEmissionBytesByGuid?.(guid);
      } catch {
        emission = null;
      }
      if (emission) exportAssets.push({ guid: areaEmissionExportGuid(guid), type: AREA_EMISSION_EXPORT_TYPE, sceneGuid: packSceneGuidForAsset(guid, startup, closure.value.bySceneGuid), bytes: emission, encoding: "bytes", name: `${asset.name} Area Emission` });
    }
    if (bytes) {
      const payload = params.payloadByGuid?.(guid);
      const textureSize = texturePixelSizeFromPayload(payload);
      exportAssets.push({
        guid,
        assetPath: asset.path,
        parentClass: asset.parentClass,
        dependencies: asset.dependencies,
        requiredDependencies: asset.requiredDependencies,
        requiredVariableNames: asset.requiredVariableNames,
        classReferences: asset.classReferences,
        requiredClassReferences: asset.requiredClassReferences,
        consoleCommand: asset.consoleCommand,
        dependencyMetadataVersion: asset.dependencyMetadataVersion,
        startupRequired: asset.type === "InputAction" || asset.type === "InputAxis" || asset.guid === params.audioMixerGuid || (asset.type === "Class" && !!asset.path && !!params.gameInstanceClass && classIdForAssetPath(asset.path) === params.gameInstanceClass) || (asset.type === "Class" && !!asset.parentClass && subsystemBaseClassIdOf(subsystemHierarchy, asset.parentClass) !== null),
        type: asset.type,
        sceneGuid: packSceneGuidForAsset(
          guid,
          startup,
          closure.value.bySceneGuid,
        ),
        bytes,
        name:
          asset.type === "Font"
            ? normalizeFontPayload(params.payloadByGuid?.(guid), asset.name)
                .family
            : asset.name,
        ...(asset.type === "Texture" && textureSize ? textureSize : {}),
      });
    }
  }
  for (const guid of closure.value.guids) {
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
  for (const guid of closure.value.guids) {
    const asset = params.assets.find((entry) => entry.guid === guid);
    if (!asset || asset.type !== "Scene") continue;
    let field: Uint8Array | null | undefined;
    try {
      field = params.audioReverbByGuid?.(guid);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: error instanceof AudioReverbBakeUnsavedError
          ? `${asset.name}'s audio reverb bake could not be saved: ${reason}`
          : `${asset.name} could not be read for its audio reverb bake: ${reason}`,
      };
    }
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
  for (const guid of closure.value.guids) {
    const asset = params.assets.find((entry) => entry.guid === guid);
    if (!asset || asset.type !== "Font") continue;
    const facetype = params.fontFacetypeBytesByGuid?.(guid);
    if (!facetype || facetype.byteLength === 0) continue;
    exportAssets.push({
      guid: fontFacetypeExportGuid(guid),
      type: FONT_FACETYPE_EXPORT_TYPE,
      sceneGuid: packSceneGuidForAsset(
        guid,
        startup,
        closure.value.bySceneGuid,
      ),
      bytes: facetype,
      encoding: "bytes",
      name: `${asset.name} Facetype`,
    });
  }
  for (const guid of closure.value.guids) {
    const asset = params.assets.find((entry) => entry.guid === guid);
    if (!asset || asset.type !== "Font") continue;
    const json = params.fontMsdfJsonByGuid?.(guid);
    const png = params.fontMsdfPngByGuid?.(guid);
    if (!json || json.byteLength === 0 || !png || png.byteLength === 0)
      continue;
    const sceneGuid = packSceneGuidForAsset(
      guid,
      startup,
      closure.value.bySceneGuid,
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

  const inputAssets = params.assets.flatMap((asset) => {
    if (!isInputAssetType(asset.type) || !closure.value.guids.includes(asset.guid)) return [];
    return [{ ...normalizeInputAssetPayload(asset.type, params.payloadByGuid?.(asset.guid)), guid: asset.guid, name: asset.name, type: asset.type }];
  });
  const dataCatalog: DataAssetCatalogEntry[] = params.assets.flatMap((asset) => {
    const type = asset.type;
    if (type !== "DataDefinition" && type !== "DataTree" && type !== "Structure" && type !== "Enum") return [];
    return [{ guid: asset.guid, name: asset.name, type, payload: params.payloadByGuid?.(asset.guid) }];
  });
  const typeSchemas = dataTypeSchemas(dataCatalog);
  const dataAssets = dataCatalog.flatMap((asset) => {
    if (asset.type !== "DataTree") return [];
    const index = isDataTreeAsset(asset.payload) ? buildDataTreeIndex(asset.payload).index : null;
    const entries = index ? index.orderedEntries.map(entry => ({
      id: entry.id, path: index.pathById.get(entry.id)!,
      parentPath: entry.parentId === null ? "" : index.pathById.get(entry.parentId)!,
      effectiveDefinitionGuid: index.effectiveDefinitionById.get(entry.id) ?? null,
    })) : [];
    return [{ guid: asset.guid, name: asset.name, type: asset.type,
      defaultDefinitionGuid: isDataTreeAsset(asset.payload) ? asset.payload.defaultDefinitionGuid : null,
      entries, ...(!index ? { invalid: true } : {}) }];
  });
  params.onPhase?.("Compiling");
  const scripts: ScriptBundleEntry[] = [];
  if (graphDocs.length || animDocs.length) {
    const { compileAnimGraphScripts, compileGraphDocuments, classIdForGraphPath, classDisplayNameForGraphPath } = await import("./script-compiler");
    // A script that fails codegen fails the export instead of shipping without it.
    const compileOptions = {
      stripDevelopmentOnly: !bundleDebugger,
      inputAssets,
      dataAssets,
      ...typeSchemas,
      tagRegistry: params.tagRegistry,
      throwOnError: true,
    };
    try {
      scripts.push(
        ...compileGraphDocuments(graphDocs.map(document => ({ ...document, classId: classIdForGraphPath(document.path), className: classDisplayNameForGraphPath(document.path), path: document.guid })), compileOptions),
        // Exported Animation Graph scripts are keyed by guid, as the pack is.
        ...compileAnimGraphScripts(animDocs.map(document => ({ ...document, path: document.guid })), compileOptions),
      );
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  params.onPhase?.("Writing Pack");
  let saveGame: SaveGameConfiguration | undefined;
  if (params.saveGameSettings?.definitionGuid) {
    if (!params.projectId) return { ok: false, error: "Save Game requires a stable project ID." };
    try {
      saveGame = {
        projectId: params.projectId,
        definition: validateSaveGameDefinition(params.payloadByGuid?.(params.saveGameSettings.definitionGuid)),
        defaultSlot: params.saveGameSettings.defaultSlot,
        defaultProfile: params.saveGameSettings.defaultProfile,
        preview: params.previewBuild === true,
      };
    } catch (error) { return { ok: false, error: `Save Game definition: ${error instanceof Error ? error.message : String(error)}` }; }
  }
  const packed = await exportGame({
    includePreviewDiagnostics: params.previewBuild === true,
    saveGame,
    project: params.project,
    bundleDebugger,
    startupSceneGuid: startup,
    gameInstanceClass: params.gameInstanceClass,
    audioMixerGuid: params.audioMixerGuid,
    occlusionEnabled: params.occlusionEnabled,
    reverbWetScale: params.reverbWetScale,
    reverbDecayScale: params.reverbDecayScale,
    reverbDampingScale: params.reverbDampingScale,
    renderSettings: params.renderSettings,
    defaultFontGuid: params.defaultFontGuid,
    playFrameCap: params.playFrameCap,
    touchMinTargetPx: params.touchMinTargetPx,
    pixelsPerUnit: params.pixelsPerUnit,
    sortingLayers: params.sortingLayers,
    pixelPerfect: params.pixelPerfect,
    physicsWorld: params.physicsWorld,
    infiniteLoopDetection: params.infiniteLoopDetection,
    loopCount: params.loopCount,
    inputAssets,
    focusNavigation: params.focusNavigation,
    scripts,
    assets: exportAssets,
    playerFiles: params.playerFiles,
    fileCountWarn: preset.fileCountWarn,
    fileCountFail: preset.fileCountFail,
  });
  if (isOk(packed)) {
    packed.value.warnings.push(
      ...pluginGraph.diagnostics
        .filter((diagnostic) => diagnostic.severity === "warning")
        .map((diagnostic) => diagnostic.message),
      ...packedMaterialTextureWarnings(
        params.assets,
        new Set(closure.value.guids),
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
