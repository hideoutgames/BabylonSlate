import { useMemo, useReducer } from "react";
import type {
  CollisionTriangleMesh,
  DataAssetCatalogEntry,
  RenderTargetPayload,
  RenderTargetTexturePayload,
  RuntimeAssetCatalogEntry,
  SerializedScene,
  SerializedSceneLayer,
  WaterDefinition,
} from "@haptic/core";
import type { FontAssetEntry, SpawnableLight } from "@haptic/render";
import type { MaterialDocument, MaterialFunctionDocument } from "@haptic/shader-graph";
import {
  emptyParticleLibrary,
  type AreaEmissionPixels,
  type ModelPayload,
  type ParticleLibrary,
  type RetargetAnimationLoad,
  type SpriteAnimationPayload,
  type SpritePayload,
  type TilemapPayload,
  type TilesetPayload,
} from "@haptic/assets";
import { emptyPlayAudioLibrary, type PlayAudioLibrary } from "../lib/play-audio";
import type {
  PlayAnimGraphEntry,
  PlayBehaviourTreeEntry,
  PlayBlackboardEntry,
} from "../lib/play-content";
import { playAssetCatalog } from "../services/asset-catalog";
import type { PreparedPlaySources } from "../services/play-asset-sources";

/**
 * The startup sources' content a Play session presents. Each field is the
 * `PlayOverlay` prop of the same name, so the overlay takes it as a spread.
 */
export interface PlayContent {
  scenes: Array<{ guid: string; scene: SerializedScene }>;
  sceneLayers: Array<{ guid: string; layer: SerializedSceneLayer }>;
  animGraphs: PlayAnimGraphEntry[];
  behaviourTrees: PlayBehaviourTreeEntry[];
  blackboards: PlayBlackboardEntry[];
  dataAssets: DataAssetCatalogEntry[];
  assetCatalog: RuntimeAssetCatalogEntry[];
  spritePayloads: Map<string, SpritePayload>;
  spriteAnimationPayloads: Map<string, SpriteAnimationPayload>;
  renderTargets: Map<string, RenderTargetPayload>;
  renderTargetTextures: Map<string, RenderTargetTexturePayload>;
  waterPayloads: Map<string, WaterDefinition>;
  tilemapPayloads: Map<string, TilemapPayload>;
  tilesetPayloads: Map<string, TilesetPayload>;
  textureBytes: Map<string, Uint8Array>;
  texturePixelSizes: Map<string, { width: number; height: number }>;
  areaEmissions: Map<string, AreaEmissionPixels>;
  fontFacetypeBytes: Map<string, Uint8Array>;
  fontMsdfJson: Map<string, Uint8Array>;
  fontMsdfPng: Map<string, Uint8Array>;
  fontFaceEntries: FontAssetEntry[];
  fontCssStack: string;
  fontCssStackByGuid: Map<string, string>;
  modelBytes: Map<string, Uint8Array>;
  modelPayloads: Map<string, ModelPayload>;
  complexMeshes: ReadonlyMap<string, CollisionTriangleMesh>;
  modelClipAnimationGuids: Map<string, Map<string, string>>;
  retargetAnimationLoads: Map<string, RetargetAnimationLoad[]>;
  audioLibrary: PlayAudioLibrary;
  particleLibrary: ParticleLibrary;
  materialDocuments: Map<string, MaterialDocument>;
  materialFunctions: Map<string, MaterialFunctionDocument>;
  /** The light parts the startup sources may spawn, which Play's load rehearses. */
  spawnableLights: ReadonlyMap<string, SpawnableLight>;
  navmeshBytes: Uint8Array | null;
  sceneNavmeshBytes: ReadonlyMap<string, Uint8Array>;
  audioReverbByScene: ReadonlyMap<string, Uint8Array>;
  audioReverbBytes: Uint8Array | null;
}

/** The audio and navigation content, which Play commits once it has collected the Input assets. */
export type PlayAudioAndNavigation = Pick<
  PlayContent,
  "audioLibrary" | "sceneNavmeshBytes" | "audioReverbByScene" | "navmeshBytes" | "audioReverbBytes"
>;

/** The rest of the content, which Play commits as soon as the startup sources are prepared. */
export type PlayPreparedContent = Omit<PlayContent, keyof PlayAudioAndNavigation>;

export type PlayContentActions = {
  /** Empties every field except the font stack, which only the next Play replaces. */
  reset(): void;
  setPrepared(content: PlayPreparedContent): void;
  setAudioAndNavigation(content: PlayAudioAndNavigation): void;
};

type PlayContentAction =
  | { type: "reset" }
  | { type: "prepared"; content: PlayPreparedContent }
  | { type: "audioAndNavigation"; content: PlayAudioAndNavigation };

/** Fresh containers on every call: a reset must re-render the overlay with new empty values. */
function emptyPlayContent(fontCssStack = "sans-serif"): PlayContent {
  return {
    scenes: [],
    sceneLayers: [],
    animGraphs: [],
    behaviourTrees: [],
    blackboards: [],
    dataAssets: [],
    assetCatalog: [],
    spritePayloads: new Map(),
    spriteAnimationPayloads: new Map(),
    renderTargets: new Map(),
    renderTargetTextures: new Map(),
    waterPayloads: new Map(),
    tilemapPayloads: new Map(),
    tilesetPayloads: new Map(),
    textureBytes: new Map(),
    texturePixelSizes: new Map(),
    areaEmissions: new Map(),
    fontFacetypeBytes: new Map(),
    fontMsdfJson: new Map(),
    fontMsdfPng: new Map(),
    fontFaceEntries: [],
    fontCssStack,
    fontCssStackByGuid: new Map(),
    modelBytes: new Map(),
    modelPayloads: new Map(),
    complexMeshes: new Map(),
    modelClipAnimationGuids: new Map(),
    retargetAnimationLoads: new Map(),
    audioLibrary: emptyPlayAudioLibrary(),
    particleLibrary: emptyParticleLibrary(),
    materialDocuments: new Map(),
    materialFunctions: new Map(),
    spawnableLights: new Map(),
    navmeshBytes: null,
    sceneNavmeshBytes: new Map(),
    audioReverbByScene: new Map(),
    audioReverbBytes: null,
  };
}

// An action replaces only its own fields, as one setter per field would.
function playContentReducer(state: PlayContent, action: PlayContentAction): PlayContent {
  switch (action.type) {
    case "reset":
      return emptyPlayContent(state.fontCssStack);
    case "prepared":
    case "audioAndNavigation":
      return { ...state, ...action.content };
  }
}

/** The content Play commits as soon as its startup sources are prepared. */
export function preparedPlayContent(
  prepared: PreparedPlaySources,
  catalog: Parameters<typeof playAssetCatalog>[0],
): PlayPreparedContent {
  const { game, content, sources } = prepared;
  return {
    scenes: [...game.scenes].map(([guid, scene]) => ({ guid, scene })),
    sceneLayers: [...game.sceneLayers].map(([guid, layer]) => ({ guid, layer })),
    dataAssets: content.dataAssets,
    assetCatalog: playAssetCatalog(catalog),
    animGraphs: content.animGraphs,
    behaviourTrees: content.behaviourTrees,
    blackboards: content.blackboards,
    spritePayloads: content.spritePayloads,
    spriteAnimationPayloads: content.spriteAnimationPayloads,
    tilemapPayloads: content.tilemapPayloads,
    tilesetPayloads: content.tilesetPayloads,
    modelBytes: game.modelBytes,
    modelPayloads: content.modelPayloads,
    // Already cooked by source preparation; Play installs these instead of cooking again.
    complexMeshes: content.complexMeshes,
    modelClipAnimationGuids: content.modelClipAnimationGuids,
    retargetAnimationLoads: content.retargetAnimationLoads,
    renderTargets: content.renderTargets,
    renderTargetTextures: content.renderTargetTextures,
    waterPayloads: content.waterPayloads,
    particleLibrary: content.particleLibrary,
    materialDocuments: content.materialDocuments,
    materialFunctions: content.materialFunctions,
    spawnableLights: sources.spawnableLights ?? new Map(),
    textureBytes: game.textureBytes,
    texturePixelSizes: content.texturePixelSizes,
    areaEmissions: game.areaEmissions,
    fontFacetypeBytes: game.fontFacetypeBytes,
    fontMsdfJson: game.fontMsdfJson,
    fontMsdfPng: game.fontMsdfPng,
    fontFaceEntries: [...(sources.fonts ?? [])],
    fontCssStack: sources.assets?.fontCssStack ?? "sans-serif",
    fontCssStackByGuid: new Map(sources.assets?.fontCssStackByGuid ?? []),
  };
}

/** The audio and navigation content for the startup Scene `sceneGuid`. */
export function playAudioAndNavigation(prepared: PreparedPlaySources, sceneGuid: string): PlayAudioAndNavigation {
  const { game, content } = prepared;
  return {
    audioLibrary: content.audioLibrary,
    sceneNavmeshBytes: game.navmeshBytes,
    audioReverbByScene: game.audioReverbBytes,
    navmeshBytes: game.navmeshBytes.get(sceneGuid) ?? null,
    audioReverbBytes: game.audioReverbBytes.get(sceneGuid) ?? null,
  };
}

/**
 * The Play content and its actions. The actions keep their identity for the
 * provider's lifetime, so the callbacks that release sources stay stable.
 */
export function usePlayContent(): [PlayContent, PlayContentActions] {
  const [content, dispatch] = useReducer(playContentReducer, undefined, () => emptyPlayContent());
  const actions = useMemo<PlayContentActions>(() => ({
    reset: () => dispatch({ type: "reset" }),
    setPrepared: (next) => dispatch({ type: "prepared", content: next }),
    setAudioAndNavigation: (next) => dispatch({ type: "audioAndNavigation", content: next }),
  }), []);
  return [content, actions];
}
