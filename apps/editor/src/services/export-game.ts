import {
  collectExportClosure,
  exportGame,
  zipExport,
  MISSING_STARTUP_SCENE_MESSAGE,
  NAVMESH_EXPORT_TYPE,
  navmeshExportGuid,
  type ExportAssetBytes,
  type ExportIndexedAsset,
  type ExportArtifact,
} from "@babylonslate/exporter";
import {
  defaultExportPreset,
  type ExportPreset,
  type RenderProjectSettings,
  isErr,
  type Result,
  type SerializedGraph,
  type SerializedScene,
} from "@babylonslate/core";
import {
  normalizeFontPayload,
  resolvePluginEnabled,
  type IndexedAsset,
} from "@babylonslate/assets";
import type { ScriptBundleEntry } from "@babylonslate/bridge";
import {
  compileGraphDocuments,
  compileGraphDocumentsForExport,
} from "./script-compiler";
import { logicGraphFromUiPayload } from "../lib/play-content";

export { MISSING_STARTUP_SCENE_MESSAGE };

export function assetsFromIndexed(
  list: ReadonlyArray<IndexedAsset>,
): ExportIndexedAsset[] {
  return list.map((asset) => ({
    guid: asset.header.guid,
    type: asset.header.type,
    name: asset.header.name,
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
  customResolution: RenderProjectSettings;
  playFrameCap: number;
  pixelsPerUnit?: number;
  pixelPerfect?: boolean;
  physicsWorld: "2d" | "3d";
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
    if (asset.type === "UserInterface") {
      const uiGraph = logicGraphFromUiPayload(
        `assets/${asset.name}.ui.babasset`,
        params.payloadByGuid?.(guid) ?? null,
      );
      if (uiGraph) graphDocs.push(uiGraph);
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

  params.onPhase?.("Compiling");
  const scripts: ScriptBundleEntry[] = bundleDebugger
    ? compileGraphDocuments(graphDocs)
    : compileGraphDocumentsForExport(graphDocs);

  params.onPhase?.("Writing Pack");
  return exportGame({
    mode,
    bundleDebugger,
    startupSceneGuid: startup,
    customResolution: params.customResolution,
    playFrameCap: params.playFrameCap,
    pixelsPerUnit: params.pixelsPerUnit,
    pixelPerfect: params.pixelPerfect,
    physicsWorld: params.physicsWorld,
    scripts,
    assets: exportAssets,
    playerFiles: params.playerFiles,
    extraFiles: params.extraFiles,
    fileCountWarn: preset.fileCountWarn,
    fileCountFail: preset.fileCountFail,
  });
}

export function zipGameArtifact(artifact: ExportArtifact): Uint8Array {
  return zipExport(artifact);
}
