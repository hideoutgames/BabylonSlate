import {
  collectExportClosure,
  exportGame,
  zipExport,
  MISSING_STARTUP_SCENE_MESSAGE,
  type ExportAssetBytes,
  type ExportIndexedAsset,
  type ExportArtifact,
} from "@babylonslate/exporter";
import {
  defaultExportPreset,
  type ExportPreset,
  type RenderProjectSettings,
  type SerializedGraph,
  type SerializedScene,
} from "@babylonslate/core";
import { resolvePluginEnabled } from "@babylonslate/assets";
import type { ScriptBundleEntry } from "@babylonslate/bridge";
import {
  compileGraphDocuments,
  compileGraphDocumentsForExport,
} from "./script-compiler";
import type { IndexedAsset } from "@babylonslate/assets";

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
  customResolution: RenderProjectSettings;
  playFrameCap: number;
  physicsWorld: "2d" | "3d";
  playerFiles: Map<string, Uint8Array>;
  extraFiles?: Map<string, Uint8Array>;
  /** Preview Build keeps Development Only nodes. */
  previewBuild?: boolean;
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
): Promise<{ ok: true; value: ExportArtifact } | { ok: false; error: string }> {
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
  });
  if (!closure.ok) return closure;

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
    const bytes = params.bytesByGuid(guid);
    if (bytes) {
      exportAssets.push({
        guid,
        type: asset.type,
        sceneGuid: sceneGuidForAsset(guid, startup, params.assets, params.sceneByGuid),
        bytes,
      });
    }
  }

  const scripts: ScriptBundleEntry[] = bundleDebugger
    ? compileGraphDocuments(graphDocs)
    : compileGraphDocumentsForExport(graphDocs);

  return exportGame({
    mode,
    bundleDebugger,
    startupSceneGuid: startup,
    customResolution: params.customResolution,
    playFrameCap: params.playFrameCap,
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
