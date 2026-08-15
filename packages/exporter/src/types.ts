import type { RenderProjectSettings, SerializedGraph, SerializedScene } from "@babylonslate/core";
import type { ScriptBundleEntry } from "@babylonslate/bridge";

export type ExportMode = "packed" | "loose";

export type ExportIndexedAsset = {
  guid: string;
  type: string;
  name: string;
  parentClass?: string | null;
  dependencies: string[];
  rootId: string;
};

export type ExportClosureInput = {
  startupSceneGuid: string | null;
  assets: readonly ExportIndexedAsset[];
  pluginEnabledGuids: ReadonlySet<string>;
  parentOf: (classId: string) => string | null | undefined;
  sceneByGuid: (guid: string) => SerializedScene | null;
  graphByGuid: (guid: string) => SerializedGraph | null;
  payloadByGuid?: (guid: string) => unknown | null;
};

export type ExportAssetBytes = {
  guid: string;
  type: string;
  /** Scene guid this asset was reached through; boot assets use the startup scene. */
  sceneGuid: string;
  bytes: Uint8Array;
  encoding?: "json" | "bytes";
};

export type GameAssetIndexEntry = {
  guid: string;
  type: string;
  encoding: "json" | "bytes";
  pack?: string;
  path?: string;
};

export type GameManifest = {
  startupSceneGuid: string;
  bundleDebugger: boolean;
  mode: ExportMode;
  render: RenderProjectSettings;
  playFrameCap: number;
  packs: string[];
  scriptsFile: string;
  physicsWorld: "2d" | "3d";
  assets: GameAssetIndexEntry[];
};

export type ExportGameOptions = {
  mode?: ExportMode;
  bundleDebugger: boolean;
  startupSceneGuid: string;
  customResolution: RenderProjectSettings;
  playFrameCap?: number;
  physicsWorld?: "2d" | "3d";
  scripts: readonly ScriptBundleEntry[];
  assets: readonly ExportAssetBytes[];
  playerFiles?: ReadonlyMap<string, Uint8Array>;
  extraFiles?: ReadonlyMap<string, Uint8Array>;
  fileCountWarn?: number;
  fileCountFail?: number;
};

export type ExportArtifact = {
  files: Map<string, Uint8Array>;
  fileCount: number;
  warnings: string[];
  manifest: GameManifest;
};
