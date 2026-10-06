import type {
  RenderProjectSettings,
  ProjectInputSettings,
  SerializedGraph,
  SerializedScene,
} from "@babylonslate/core";
import type { ScriptBundleEntry } from "@babylonslate/bridge";

export type ExportMode = "packed" | "loose";

export type ExportIndexedAsset = {
  guid: string;
  type: string;
  name: string;
  /** Asset path. */
  path?: string;
  parentClass?: string | null;
  dependencies: string[];
  requiredDependencies?: string[];
  requiredVariableNames?: string[];
  dependencyMetadataVersion?: number;
  rootId: string;
};

export type ExportClosureInput = {
  startupSceneGuid: string | null;
  saveGameDefinitionGuid?: string | null;
  /** Project Game Instance class id; packed even when scene settings omit it. */
  gameInstanceClass?: string | null;
  /** Project AudioMixer guid; packed even when no scene actor references it. */
  audioMixerGuid?: string | null;
  /** Assets referenced by project render settings, such as the grading LUT. */
  renderAssetGuids?: readonly string[];
  assets: readonly ExportIndexedAsset[];
  pluginEnabledGuids: ReadonlySet<string>;
  parentOf: (classId: string) => string | null | undefined;
  sceneByGuid: (guid: string) => SerializedScene | null;
  graphByGuid: (guid: string) => SerializedGraph | null;
  payloadByGuid?: (guid: string) => unknown | null;
};

/** The complete export closure and the assets attributable to each Scene root. */
export type ExportReachability = {
  guids: string[];
  bySceneGuid: ReadonlyMap<string, ReadonlySet<string>>;
};

export type ExportAssetBytes = {
  guid: string;
  type: string;
  parentClass?: string | null;
  /** Complete references retained for export and explicit dynamic lookup. */
  dependencies?: readonly string[];
  /** Dependencies needed whenever this asset is acquired. */
  requiredDependencies?: readonly string[];
  requiredVariableNames?: readonly string[];
  dependencyMetadataVersion?: number;
  /** A required project system independent of the initial scene. */
  startupRequired?: boolean;
  /** Scene guid this asset was reached through; boot assets use the startup scene. */
  sceneGuid: string;
  bytes: Uint8Array;
  encoding?: "json" | "bytes";
  /** Asset display name; FontFace family falls back to this. */
  name?: string;
  /** Authored Texture payload pixels for overlay 2DTexture layout. */
  width?: number;
  height?: number;
};

export type GameAssetIndexEntry = {
  guid: string;
  type: string;
  encoding: "json" | "bytes";
  byteLength?: number;
  revision?: string;
  dependencies?: string[];
  requiredDependencies?: string[];
  startupRequired?: boolean;
  pack?: string;
  path?: string;
  name?: string;
  /** Authored Texture payload pixels for overlay 2DTexture layout. */
  width?: number;
  height?: number;
};

export type GameManifest = {
  /** Version 1 uses independent files and required-edge loading. */
  assetCatalogVersion?: 1;
  saveGame?: import("@babylonslate/core").SaveGameConfiguration;
  /** Authored build identity; absent in legacy builds. */
  project?: { name: string; version: string };
  inputAssets?: import("@babylonslate/core").InputAssetDefinition[];
  inputMappings?: ProjectInputSettings;
  focusNavigation?: import("@babylonslate/core").FocusNavigationSettings;
  startupSceneGuid: string;
  gameInstanceClass?: string;
  audioMixerGuid?: string;
  defaultFontGuid?: string;
  occlusionEnabled?: boolean;
  reverbWetScale?: number;
  reverbDecayScale?: number;
  reverbDampingScale?: number;
  bundleDebugger: boolean;
  mode: ExportMode;
  render: RenderProjectSettings;
  playFrameCap: number;
  touchMinTargetPx?: number;
  pixelsPerUnit: number;
  /** Ordered 2D sorting layers; absent in older exports. */
  sortingLayers?: readonly string[];
  pixelPerfect: boolean;
  packs: string[];
  /** Script registry path. Legacy manifests that omit it migrate to `scripts.js`. */
  scriptsFile: string;
  physicsWorld: "2d" | "3d";
  assets: GameAssetIndexEntry[];
  /** Present only when `bundleDebugger` is true. */
  infiniteLoopDetection?: boolean;
  /** Present only when `bundleDebugger` is true. */
  loopCount?: number;
};

export type ExportGameOptions = {
  defaultFontGuid?: string | null;
  saveGame?: import("@babylonslate/core").SaveGameConfiguration;
  project?: { name: string; version: string };
  inputAssets?: import("@babylonslate/core").InputAssetDefinition[];
  inputMappings?: ProjectInputSettings;
  focusNavigation?: import("@babylonslate/core").FocusNavigationSettings;
  mode?: ExportMode;
  bundleDebugger: boolean;
  startupSceneGuid: string;
  gameInstanceClass?: string | null;
  audioMixerGuid?: string | null;
  occlusionEnabled?: boolean;
  reverbWetScale?: number;
  reverbDecayScale?: number;
  reverbDampingScale?: number;
  /** Complete authored rendering defaults, serialized as game.json `render`. */
  renderSettings: RenderProjectSettings;
  playFrameCap?: number;
  touchMinTargetPx?: number;
  pixelsPerUnit?: number;
  sortingLayers?: readonly string[];
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
};

export type ExportArtifact = {
  files: Map<string, Uint8Array>;
  fileCount: number;
  warnings: string[];
  manifest: GameManifest;
};
