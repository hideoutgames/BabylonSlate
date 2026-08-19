import type { RenderProjectSettings, SerializedGraph, SerializedScene } from "@babylonslate/core";
import type { ScriptBundleEntry } from "@babylonslate/bridge";

export type ExportMode = "packed" | "loose";

export type ExportIndexedAsset = {
  guid: string;
  type: string;
  name: string;
  /** Asset path; UserInterface logic compiles from this so class ids match overlay Play. */
  path?: string;
  parentClass?: string | null;
  dependencies: string[];
  rootId: string;
};

export type ExportClosureInput = {
  startupSceneGuid: string | null;
  /** Project Game Instance class id; packed even when scene settings omit it. */
  gameInstanceClass?: string | null;
  /** Project AudioMixer guid; packed even when no scene actor references it. */
  audioMixerGuid?: string | null;
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
  /** Asset display name; FontFace family falls back to this. */
  name?: string;
};

export type GameAssetIndexEntry = {
  guid: string;
  type: string;
  encoding: "json" | "bytes";
  pack?: string;
  path?: string;
  name?: string;
};

export type PackedUiDesignerPreset = {
  id: string;
  label: string;
  width: number;
  height: number;
  safeArea: {
    left: number;
    right: number;
    top: number;
    bottom: number;
  };
};

export type GameManifest = {
  startupSceneGuid: string;
  gameInstanceClass?: string;
  audioMixerGuid?: string;
  occlusionEnabled?: boolean;
  reverbWetScale?: number;
  reverbDecayScale?: number;
  reverbDampingScale?: number;
  bundleDebugger: boolean;
  mode: ExportMode;
  render: RenderProjectSettings;
  playFrameCap: number;
  pixelsPerUnit: number;
  pixelPerfect: boolean;
  packs: string[];
  scriptsFile: string;
  physicsWorld: "2d" | "3d";
  assets: GameAssetIndexEntry[];
  /** Present only when `bundleDebugger` is true. */
  infiniteLoopDetection?: boolean;
  /** Present only when `bundleDebugger` is true. */
  loopCount?: number;
  /** Engine Settings `uiDesignerPresets` packed for HUD Safe Area matching. */
  uiDesignerPresets?: PackedUiDesignerPreset[];
  /** Project Settings User Interface design space (Play/player ADT ideal). */
  ui?: {
    designResolution: { width: number; height: number };
    scaleRule: "fitWidth" | "fitHeight" | "shortestSide";
  };
};

export type ExportGameOptions = {
  mode?: ExportMode;
  bundleDebugger: boolean;
  startupSceneGuid: string;
  gameInstanceClass?: string | null;
  audioMixerGuid?: string | null;
  occlusionEnabled?: boolean;
  reverbWetScale?: number;
  reverbDecayScale?: number;
  reverbDampingScale?: number;
  customResolution: RenderProjectSettings;
  playFrameCap?: number;
  pixelsPerUnit?: number;
  pixelPerfect?: boolean;
  physicsWorld?: "2d" | "3d";
  infiniteLoopDetection?: boolean;
  loopCount?: number;
  scripts: readonly ScriptBundleEntry[];
  assets: readonly ExportAssetBytes[];
  playerFiles?: ReadonlyMap<string, Uint8Array>;
  extraFiles?: ReadonlyMap<string, Uint8Array>;
  fileCountWarn?: number;
  fileCountFail?: number;
  uiDesignerPresets?: readonly PackedUiDesignerPreset[];
  ui?: {
    designResolution: { width: number; height: number };
    scaleRule: "fitWidth" | "fitHeight" | "shortestSide";
  };
};

export type ExportArtifact = {
  files: Map<string, Uint8Array>;
  fileCount: number;
  warnings: string[];
  manifest: GameManifest;
};
