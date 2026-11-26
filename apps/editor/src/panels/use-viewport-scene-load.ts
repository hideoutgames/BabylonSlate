import { useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import {
  areaEmissionTextureGuids,
  renderEffectsAssetGuids,
  resolveRenderEffectsSettings,
  type EnvironmentLightingSettings,
  type SerializedScene,
} from "@haptic/core";
import {
  engineAdapterInfo,
  type EngineHandle,
  type EditorSceneLoadOptions,
  type SceneLoadCount,
} from "@haptic/render";
import {
  useDocumentActions,
  useProjectState,
  useRegistryState,
} from "../context/document-context";
import { waitForCanvasSize } from "../lib/canvas-resize-guard";
import {
  modelSlotMaterialGuidsFromPayloads,
  overlayTextureGuidsFromScene,
  skyboxFaceGuidsFromScene,
  environmentTextureGuidsFromScenes,
  postProcessTextureGuidsFromScenes,
  materialInstanceTextureGuidsFromScenes,
  textureGuidsFromPlayPayloads,
} from "../lib/play-content";
import { fontMsdfMapsFromPairs, fontGuidsForSceneRepresentation } from "../lib/play-fonts";
import { savedMaterialLibraryKey } from "../lib/material-asset-revision";
import {
  changedTextureEncodings,
  sceneViewportAssetKey,
  sceneViewportRequiredAssets,
  sceneViewportTextureEncodings,
  stableViewportPayloadRevisions,
  viewportPayloadRevisions,
} from "../lib/scene-viewport-assets";
import { savedAreaEmissionKey } from "../lib/collect-area-emissions";
import { prepareReferencedAreaEmissions } from "../lib/area-emission-preparation";
import {
  isSceneViewportRemountLoad,
  runSceneViewportBlockingLoad,
  sceneViewportRenderSettings,
  type SceneViewportLoadPhase,
} from "../lib/scene-viewport-load";
import { waitForSceneLoadingPaint } from "@haptic/render/scene-load-readiness";
import {
  getCachedViewportCollection,
  putCachedViewportCollection,
} from "../lib/viewport-collection-cache";
import { useLiveTilemapEdits } from "./use-live-tilemap-edits";

/** The Scene viewport's loading dialog and failure state. */
export interface ViewportSceneLoadState {
  open: boolean;
  progress: number;
  phase: SceneViewportLoadPhase;
  /** The phase's count when it has one (Compiling Shaders). */
  count?: SceneLoadCount;
  failed?: boolean;
  rendering?: boolean;
  /** Kept for Debug Mode's Copy Error. */
  error?: unknown;
  /** The adapter at failure time; the Engine is released right after. */
  gpu?: ReturnType<typeof engineAdapterInfo> | null;
}

/** The scene and Engine the last finished load realized; Drop and Texture swaps wait for it. */
export type ViewportDropReady = {
  scene: SerializedScene;
  handle: EngineHandle;
} | null;

export interface ViewportSceneLoadDeps {
  scene: SerializedScene | null;
  /** `scene` as the viewport realizes it, with Scene Streaming labels. */
  editorScene: SerializedScene | null;
  /** The document's path, which names the scene's asset GUID. */
  scenePath: string | undefined;
  requestedRenderSettingsKey: string;
  renderSettingsKey: string;
  engineEpoch: number;
  dropReady: ViewportDropReady;
  editorTextureLodEnabled: boolean;
  editorTextureLodQuality: number;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  engineRef: RefObject<EngineHandle | null>;
  releaseEngineRef: RefObject<(() => void) | null>;
  simulationDetachedRef: RefObject<boolean>;
  blockingLoadRef: RefObject<AbortController | null>;
  loadTransitionRef: RefObject<number>;
  engineGenerationRef: RefObject<number>;
  appliedRenderSettingsRef: RefObject<string | null>;
  environmentSettingsRef: RefObject<EnvironmentLightingSettings | undefined>;
  setDropReady: Dispatch<SetStateAction<ViewportDropReady>>;
  setSceneReady: Dispatch<SetStateAction<boolean>>;
  setSceneLoad: Dispatch<SetStateAction<ViewportSceneLoadState>>;
}

/**
 * Loads the document's scene and its assets into the viewport Engine: blocking
 * loads behind the loading dialog, incremental loads after edits, and in-place
 * Texture-encoding swaps. React runs its effects in call order, so the panel
 * calls it where these effects have always run.
 */
/**
 * True when two Scene snapshots keep the exact same settings, actor classes,
 * component arrays and actor properties, so only transforms, names, folders or
 * visibility/lock flags changed and asset/emission scans produce the same result.
 */
function sameSceneAssetReferences(
  previous: SerializedScene | null,
  next: SerializedScene | null,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return false;
  if (previous.settings !== next.settings || previous.actors.length !== next.actors.length) {
    return false;
  }
  for (let index = 0; index < next.actors.length; index++) {
    const a = previous.actors[index]!;
    const b = next.actors[index]!;
    if (a === b) continue;
    if (
      a.id !== b.id ||
      a.classId !== b.classId ||
      a.components !== b.components ||
      a.properties !== b.properties
    ) {
      return false;
    }
  }
  return true;
}

export function useViewportSceneLoad({
  scene,
  editorScene,
  scenePath,
  requestedRenderSettingsKey,
  renderSettingsKey,
  engineEpoch,
  dropReady,
  editorTextureLodEnabled,
  editorTextureLodQuality,
  canvasRef,
  engineRef,
  releaseEngineRef,
  simulationDetachedRef,
  blockingLoadRef,
  loadTransitionRef,
  engineGenerationRef,
  appliedRenderSettingsRef,
  environmentSettingsRef,
  setDropReady,
  setSceneReady,
  setSceneLoad,
}: ViewportSceneLoadDeps): void {
  const {
    collectPlaySpritePayloads,
    collectPlayWaterContent,
    collectPlayRenderTargets,
    collectPlayTilemapContent,
    collectPlayTextureBytes,
    collectPlayTexturePixelSizes,
    collectPlayFontFacetypeBytes,
    collectPlayAreaEmissions,
    prepareAreaEmission,
    collectPlayFontMsdfPair,
    collectPlayFontFaceEntries,
    collectPlayFontCssStacks,
    collectPlayModelBytes,
    collectPlayModelPayloads,
    collectPlayMaterialLibrary,
    getOpenDocuments,
  } = useDocumentActions();
  const { projectDocument } = useProjectState();
  const { assetRegistry, registryEpoch } = useRegistryState();
  const appliedSceneRef = useRef<{ scene: SerializedScene; handle: EngineHandle } | null>(null);
  /** `textures` maps each installed Texture to the stored encoding its bytes came from. */
  const appliedAssetsRef = useRef<{ key: string; handle: EngineHandle; textures: Map<string, string> } | null>(null);
  /** The asset load in flight; an encoding swap waits for it rather than racing its install. */
  const assetLoadRef = useRef<AbortController | null>(null);
  /** The Texture-encoding swap for one applied asset set; `attempted` is the registry view its last pass finished against. */
  const textureSwapRef = useRef<{
    applied: object;
    attempted: ReadonlyMap<string, string> | null;
    running: boolean;
    controller: AbortController;
  } | null>(null);
  const completedLoadGenerationRef = useRef(-1);
  const completedRenderSettingsRef = useRef<string | null>(null);
  const sceneAssetGuidRef = useRef<string | undefined>(undefined);
  sceneAssetGuidRef.current = scenePath
    ? assetRegistry?.getByPath?.(scenePath)?.header.guid
    : undefined;

  // Open Tilemap edits reach the viewport as they are made; a Tilemap closed with unsaved edits loads its saved map again.
  const [discardedTilemaps, setDiscardedTilemaps] = useState(0);
  useLiveTilemapEdits({ scene, engineRef, onDiscarded: () => setDiscardedTilemaps((count) => count + 1) });
  const textureLodKey = `${editorTextureLodEnabled}:${editorTextureLodQuality}`;
  // The LUT the project's Color Grading or the Scene's Post Processing override names.
  const effectsAssetGuidsKey = JSON.stringify(renderEffectsAssetGuids(
    resolveRenderEffectsSettings(projectDocument?.settings.render.effects, scene?.settings.effectsOverrides),
  ));
  // Depends on the registry alone, so Scene edits do not rebuild it.
  const materialLibraryKey = useMemo(() => {
    void registryEpoch;
    return savedMaterialLibraryKey(assetRegistry?.list() ?? []);
  }, [assetRegistry, registryEpoch]);
  // Retain the last scene whose asset-bearing fields (settings, actor classes,
  // components, actor properties) changed so transform scrubs skip full-scene
  // asset key and area-emission scans.
  const assetScanSceneRef = useRef<SerializedScene | null>(scene);
  if (!sameSceneAssetReferences(assetScanSceneRef.current, scene)) {
    assetScanSceneRef.current = scene;
  }
  const assetScanScene = assetScanSceneRef.current;

  const viewportAssetsKey = useMemo(() => {
    void registryEpoch;
    return JSON.stringify([
      sceneViewportAssetKey(assetScanScene, assetRegistry?.list() ?? []),
      textureLodKey,
      effectsAssetGuidsKey,
      projectDocument?.settings.twoD,
      projectDocument?.settings.fonts,
      discardedTilemaps,
    ]);
  }, [
    assetRegistry,
    assetScanScene,
    discardedTilemaps,
    registryEpoch,
    textureLodKey,
    effectsAssetGuidsKey,
    projectDocument?.settings.twoD,
    projectDocument?.settings.fonts,
  ]);
  const areaTextureGuids = useMemo(() => areaEmissionTextureGuids(assetScanScene), [assetScanScene]);
  const areaEmissionKey = savedAreaEmissionKey(areaTextureGuids, (guid) => assetRegistry?.getByGuid(guid));
  // An assigned emission Texture without prepared data would leave its light off.
  useEffect(() => {
    if (assetRegistry) prepareReferencedAreaEmissions(areaTextureGuids, (guid) => assetRegistry.getByGuid(guid), (guid) => prepareAreaEmission(guid));
  }, [areaTextureGuids, areaEmissionKey, assetRegistry, prepareAreaEmission]);
  // How each Texture is stored. An encode commit changes this and not `viewportAssetsKey`.
  const textureEncodings = useMemo(() => {
    void registryEpoch;
    return sceneViewportTextureEncodings(assetRegistry?.list() ?? []);
  }, [assetRegistry, registryEpoch]);
  const textureEncodingsRef = useRef(textureEncodings);
  textureEncodingsRef.current = textureEncodings;
  const textureEncodingsKey = useMemo(() => JSON.stringify([...textureEncodings]), [textureEncodings]);

  useEffect(() => {
    const handle = engineRef.current;
    if (!scene || !editorScene || !handle || simulationDetachedRef.current) return;
    // Scene overrides arrive before the coalesced settings transaction. Do not
    // apply them through incremental loadScene while its blocking UI is pending.
    if (requestedRenderSettingsKey !== renderSettingsKey) return;
    const controller = new AbortController();
    assetLoadRef.current = controller;
    const transitionId = ++loadTransitionRef.current;
    const isCurrent = () => !controller.signal.aborted &&
      transitionId === loadTransitionRef.current && engineRef.current === handle;
    const generation = engineGenerationRef.current;
    const remount = isSceneViewportRemountLoad(
      generation,
      completedLoadGenerationRef.current,
    );
    const rendering = !remount && completedRenderSettingsRef.current !== renderSettingsKey;
    const blocking = remount || rendering;
    if (blocking) {
      setDropReady(null);
      setSceneReady(false);
      blockingLoadRef.current = controller;
      handle.setPaused(true);
      setSceneLoad({ open: false, progress: 0, phase: "Preparing Scene", rendering });
    }
    void (async () => {
      let collected: EditorSceneLoadOptions | null = null;
      let pendingIncrementalInstall: (() => void) | null = null;
      const realize = async () => {
        if (!isCurrent()) return;
        if (appliedRenderSettingsRef.current !== renderSettingsKey) {
          handle.setRenderSettings(sceneViewportRenderSettings(renderSettingsKey, environmentSettingsRef.current));
          appliedRenderSettingsRef.current = renderSettingsKey;
        }
        // Saved Material refreshes must not realize or re-dirty scene structure.
        if (blocking) {
          if (!collected) throw new Error("Scene assets were not collected before realization.");
          await handle.loadSceneAsync(editorScene, {
            ...collected,
            sceneAssetGuid: sceneAssetGuidRef.current,
          });
          if (!isCurrent()) return;
        } else {
          if (appliedSceneRef.current?.scene === editorScene && appliedSceneRef.current.handle === handle) return;
          handle.loadScene(editorScene, { sceneAssetGuid: sceneAssetGuidRef.current });
        }
        appliedSceneRef.current = { scene: editorScene, handle };
      };
      const applyCollectedAssets = async () => {
        if (!blocking && appliedAssetsRef.current?.handle === handle &&
          appliedAssetsRef.current.key === viewportAssetsKey) return;
        // The encodings the bytes below are read against; a commit that lands
        // while they load is swapped in afterwards.
        const encodings = textureEncodingsRef.current;
        const catalog = assetRegistry?.list() ?? [];
        // Read before collecting, and again after: a payload whose revision moved meanwhile has none.
        const payloadRevisionsBefore = viewportPayloadRevisions(catalog, getOpenDocuments());
        const collectionCacheKey = JSON.stringify([
          viewportAssetsKey,
          materialLibraryKey,
          areaEmissionKey,
          textureLodKey,
          effectsAssetGuidsKey,
          projectDocument?.settings.fonts.defaultFontGuid ?? null,
          projectDocument?.settings.fonts.globalFallback ?? null,
          [...payloadRevisionsBefore.entries()].sort(([a], [b]) => a.localeCompare(b)),
        ]);
        const cachedCollection = getCachedViewportCollection(assetRegistry, collectionCacheKey, encodings);
        let sprites: Awaited<ReturnType<typeof collectPlaySpritePayloads>>;
        let tileContent: Awaited<ReturnType<typeof collectPlayTilemapContent>>;
        let waters: Awaited<ReturnType<typeof collectPlayWaterContent>>;
        let renderTargetAssets: Awaited<ReturnType<typeof collectPlayRenderTargets>>;
        let modelBytes: Awaited<ReturnType<typeof collectPlayModelBytes>>;
        let modelPayloads: Awaited<ReturnType<typeof collectPlayModelPayloads>>;
        let materials: Awaited<ReturnType<typeof collectPlayMaterialLibrary>>;
        let textureBytes: Map<string, Uint8Array>;
        let texturePixelSizes: Map<string, { width: number; height: number }>;
        let fontFacetypeBytes: Map<string, Uint8Array>;
        let areaEmissions: Awaited<ReturnType<typeof collectPlayAreaEmissions>>;
        let msdf: ReturnType<typeof fontMsdfMapsFromPairs>;
        let fontFaceEntries: Awaited<ReturnType<typeof collectPlayFontFaceEntries>>;
        let resolvedPayloadRevisions: Map<string, string>;
        if (cachedCollection) {
          sprites = cachedCollection.sprites;
          tileContent = cachedCollection.tileContent;
          waters = cachedCollection.waters;
          renderTargetAssets = cachedCollection.renderTargetAssets;
          modelBytes = cachedCollection.modelBytes;
          modelPayloads = cachedCollection.modelPayloads;
          materials = cachedCollection.materials;
          textureBytes = cachedCollection.textureBytes;
          texturePixelSizes = cachedCollection.texturePixelSizes;
          fontFacetypeBytes = cachedCollection.fontFacetypeBytes;
          areaEmissions = cachedCollection.areaEmissions;
          msdf = cachedCollection.msdf;
          fontFaceEntries = cachedCollection.fontFaceEntries;
          resolvedPayloadRevisions = cachedCollection.payloadRevisions;
        } else {
          const fontSources = catalog.map((asset) => ({ guid: asset.header.guid, path: asset.path, type: asset.header.type, payload: asset.header.payload }));
          const bitmapFonts = new Set(fontGuidsForSceneRepresentation([scene], fontSources, "source", projectDocument?.settings.fonts.defaultFontGuid));
          const required = sceneViewportRequiredAssets(scene, catalog, [
            ...(JSON.parse(effectsAssetGuidsKey) as string[]),
            ...bitmapFonts,
            ...fontGuidsForSceneRepresentation([scene], fontSources, "msdf", projectDocument?.settings.fonts.defaultFontGuid),
          ]);
          // Independent collectors read at once. When no open Model or Water tab can introduce
          // unindexed references, Materials and Textures start immediately at t=0 from the
          // transitive `required` header closure instead of waiting behind a 3-deep waterfall.
          const started = <T,>(work: Promise<T>): Promise<T> => { work.catch(() => undefined); return work; };
          const openDocs = getOpenDocuments();
          const hasOpenModelOrWater = openDocs.some(
            (doc) => doc.ref.kind === "model" || doc.ref.kind === "water",
          );
          const editorLod = {
            enabled: editorTextureLodEnabled,
            quality: editorTextureLodQuality,
          };
          const catalogByGuid = new Map(catalog.map((asset) => [asset.header.guid, asset] as const));
          const requiredMaterialGuids: string[] = [];
          const prefetchedTextureGuids: string[] = [];
          for (const guid of required) {
            const asset = catalogByGuid.get(guid);
            if (!asset) continue;
            if (asset.header.type === "Material" || asset.header.type === "MaterialInstance") {
              requiredMaterialGuids.push(guid);
            } else if (asset.header.type === "Texture") {
              prefetchedTextureGuids.push(guid);
            }
          }
          const prefetchedTextureSet = new Set(prefetchedTextureGuids);
          const spritesWork = started(collectPlaySpritePayloads(scene));
          const tileContentWork = started(collectPlayTilemapContent(scene));
          const watersWork = started(collectPlayWaterContent(required));
          const renderTargetsWork = started(collectPlayRenderTargets(required));
          const modelBytesWork = started(collectPlayModelBytes(scene, [], required));
          const modelPayloadsWork = started(collectPlayModelPayloads(scene));
          const materialsWork = started(
            !hasOpenModelOrWater
              ? collectPlayMaterialLibrary(scene, [], requiredMaterialGuids)
              : Promise.all([modelPayloadsWork, watersWork]).then(([payloads, waterContent]) => collectPlayMaterialLibrary(
                  scene,
                  [],
                  [...modelSlotMaterialGuidsFromPayloads(payloads), ...[...waterContent.values()].flatMap((water) => water.materialGuid ? [water.materialGuid] : [])],
                )),
          );
          const prefetchedTexturesWork = prefetchedTextureGuids.length > 0
            ? started(collectPlayTextureBytes(new Map(), new Map(), prefetchedTextureGuids, undefined, false, editorLod))
            : null;
          const texturesWork = started(Promise.all([spritesWork, tileContentWork, materialsWork]).then(async ([spritePayloads, tiles, materialLibrary]) => {
            const extraTextureGuids = [
              ...environmentTextureGuidsFromScenes([scene]),
              ...postProcessTextureGuidsFromScenes([scene]),
              ...materialInstanceTextureGuidsFromScenes([scene]),
              ...materialLibrary.textureGuids,
              ...skyboxFaceGuidsFromScene(scene),
              ...overlayTextureGuidsFromScene(scene),
              ...(JSON.parse(effectsAssetGuidsKey) as string[]),
            ];
            let bytes: Map<string, Uint8Array>;
            if (prefetchedTexturesWork) {
              const prefetched = await prefetchedTexturesWork;
              const wantedFromPayloads = new Set<string>([
                ...textureGuidsFromPlayPayloads(spritePayloads, tiles.tilesets),
                ...extraTextureGuids,
              ]);
              const missing = [...wantedFromPayloads].filter((guid) => guid && !prefetchedTextureSet.has(guid));
              if (missing.length === 0) {
                bytes = prefetched;
              } else {
                const extra = await collectPlayTextureBytes(new Map(), new Map(), missing, undefined, false, editorLod);
                bytes = new Map([...prefetched, ...extra]);
              }
            } else {
              bytes = await collectPlayTextureBytes(spritePayloads, tiles.tilesets, extraTextureGuids, undefined, false, editorLod);
            }
            return {
              bytes,
              pixelSizes: collectPlayTexturePixelSizes(spritePayloads, tiles.tilesets, extraTextureGuids),
            };
          }));
          const fontFacetypeWork = started(collectPlayFontFacetypeBytes(scene));
          const areaEmissionsWork = started(collectPlayAreaEmissions([scene]));
          const msdfWork = started(collectPlayFontMsdfPair(scene));
          const fontFaceEntriesWork = started(collectPlayFontFaceEntries(bitmapFonts));
          sprites = await spritesWork;
          controller.signal.throwIfAborted();
          tileContent = await tileContentWork;
          waters = await watersWork;
          renderTargetAssets = await renderTargetsWork;
          controller.signal.throwIfAborted();
          modelBytes = await modelBytesWork;
          controller.signal.throwIfAborted();
          modelPayloads = await modelPayloadsWork;
          controller.signal.throwIfAborted();
          materials = await materialsWork;
          controller.signal.throwIfAborted();
          ({ bytes: textureBytes, pixelSizes: texturePixelSizes } = await texturesWork);
          controller.signal.throwIfAborted();
          fontFacetypeBytes = await fontFacetypeWork;
          areaEmissions = await areaEmissionsWork;
          controller.signal.throwIfAborted();
          msdf = fontMsdfMapsFromPairs(await msdfWork);
          controller.signal.throwIfAborted();
          fontFaceEntries = await fontFaceEntriesWork;
          resolvedPayloadRevisions = stableViewportPayloadRevisions(
            payloadRevisionsBefore,
            viewportPayloadRevisions(assetRegistry?.list() ?? [], getOpenDocuments()),
          );
          if (isCurrent()) {
            putCachedViewportCollection(assetRegistry, collectionCacheKey, {
              sprites,
              tileContent,
              waters,
              renderTargetAssets,
              modelBytes,
              modelPayloads,
              materials,
              textureBytes,
              texturePixelSizes,
              fontFacetypeBytes,
              areaEmissions,
              msdf,
              fontFaceEntries,
              payloadRevisions: resolvedPayloadRevisions,
              encodings: new Map([...textureBytes.keys()].map((guid): [string, string] => [guid, encodings.get(guid) ?? ""])),
            });
          }
        }
        const fontCss = collectPlayFontCssStacks();
        if (!isCurrent()) return;
        await handle.registerFonts(fontFaceEntries);
        if (!isCurrent()) return;
        const assets = {
          resourceCache: handle.resourceCache,
          spritePayloads: sprites,
          tilemaps: tileContent.tilemaps,
          waters,
          payloadRevisions: resolvedPayloadRevisions,
          ...renderTargetAssets,
          tilesets: tileContent.tilesets,
          textureBytes,
          texturePixelSizes,
          fontFacetypeBytes,
          areaEmissions,
          fontMsdfJson: msdf.json,
          fontMsdfPng: msdf.png,
          fontCssStack: fontCss.fontCssStack,
          fontCssStackByGuid: fontCss.fontCssStackByGuid,
          fontPixelSize: fontCss.fontPixelSize,
          fontPixelSizeByGuid: fontCss.fontPixelSizeByGuid,
          modelBytes,
          modelPayloads,
          pixelsPerUnit: projectDocument?.settings.twoD.pixelsPerUnit,
          sortingLayers: projectDocument?.settings.twoD.sortingLayers,
        };
        if (blocking) {
          collected = {
            signal: controller.signal,
            assets,
            materialDocuments: materials.documents,
            materialFunctions: materials.functions,
            budgetMs: 24,
            onProgress: (progress) => {
              if (isCurrent()) setSceneLoad({ open: true, progress: 20 + 25 * progress, phase: "Realizing Scene", rendering });
            },
          };
        } else {
          pendingIncrementalInstall = () => {
            handle.setMaterialDocuments(materials.documents, materials.functions);
            handle.setMeshAssets(assets);
          };
        }
        if (isCurrent()) {
          appliedAssetsRef.current = {
            key: viewportAssetsKey,
            handle,
            textures: new Map([...textureBytes.keys()].map((guid): [string, string] => [guid, encodings.get(guid) ?? ""])),
          };
        }
      };
      try {
        if (blocking) {
          const canvas = canvasRef.current;
          if (!canvas) return;
          await waitForCanvasSize(canvas, controller.signal);
          if (!isCurrent()) return;
          setSceneLoad({ open: true, progress: 0, phase: "Preparing Scene", rendering });
          await runSceneViewportBlockingLoad({
            signal: controller.signal,
            dialogAlreadyPainted: remount,
            realize,
            collect: applyCollectedAssets,
            whenModelsReady: async () => {
              if (!isCurrent()) return;
              await handle.whenEditorModelsReady();
              if (!isCurrent()) return;
              await handle.whenMaterialTexturesReady();
            },
            warmShaders: async (onCount) => {
              if (!isCurrent()) return;
              await handle.prewarmSceneMaterials(undefined, onCount);
            },
            presentFirstFrame: async () => {
              if (!isCurrent()) return;
              await handle.presentFirstFrame();
            },
            onProgress: (progress, phase, count) => {
              if (!isCurrent()) return;
              setSceneLoad({ open: true, progress, phase, count, rendering });
            },
          });
        } else {
          await applyCollectedAssets();
          if (!isCurrent()) return;
          const commitIncremental = () => {
            pendingIncrementalInstall?.();
            if (appliedRenderSettingsRef.current !== renderSettingsKey) {
              handle.setRenderSettings(sceneViewportRenderSettings(renderSettingsKey, environmentSettingsRef.current));
              appliedRenderSettingsRef.current = renderSettingsKey;
            }
            if (appliedSceneRef.current?.scene !== editorScene || appliedSceneRef.current.handle !== handle) {
              handle.loadScene(editorScene, { sceneAssetGuid: sceneAssetGuidRef.current });
              appliedSceneRef.current = { scene: editorScene, handle };
            }
          };
          if (pendingIncrementalInstall && handle.batchEditorApply) {
            handle.batchEditorApply(commitIncremental);
          } else {
            commitIncremental();
          }
          if (isCurrent()) {
            await handle.whenEditorModelsReady();
          }
        }
        if (isCurrent()) {
          setDropReady({ scene, handle });
          if (blocking) {
            completedLoadGenerationRef.current = generation;
            completedRenderSettingsRef.current = renderSettingsKey;
            setSceneLoad({
              open: false,
              progress: 100,
              phase: "Presenting First Frame",
              rendering,
            });
          }
          setSceneReady(true);
        }
      } catch (error) {
        if (!isCurrent()) return;
        console.error("[viewport] failed to load scene", error);
        const gpu = (() => {
          const engine = engineRef.current?.engine;
          try { return engine ? engineAdapterInfo(engine) : null; } catch { return null; }
        })();
        releaseEngineRef.current?.();
        setSceneLoad((current) => ({ ...current, open: true, failed: true, error, gpu }));
      } finally {
        if (blockingLoadRef.current === controller) blockingLoadRef.current = null;
        if (assetLoadRef.current === controller) assetLoadRef.current = null;
      }
    })();
    return () => {
      controller.abort();
      if (assetLoadRef.current === controller) assetLoadRef.current = null;
    };
  }, [
    scene,
    editorScene,
    viewportAssetsKey,
    requestedRenderSettingsKey,
    renderSettingsKey,
    materialLibraryKey,
    areaEmissionKey,
    textureLodKey,
    editorTextureLodEnabled,
    editorTextureLodQuality,
    effectsAssetGuidsKey,
    collectPlaySpritePayloads,
    collectPlayWaterContent,
    collectPlayRenderTargets,
    collectPlayTilemapContent,
    collectPlayTextureBytes,
    collectPlayTexturePixelSizes,
    collectPlayFontFacetypeBytes,
    collectPlayAreaEmissions,
    collectPlayFontMsdfPair,
    collectPlayFontFaceEntries,
    collectPlayFontCssStacks,
    collectPlayModelBytes,
    collectPlayModelPayloads,
    collectPlayMaterialLibrary,
    getOpenDocuments,
    projectDocument?.settings.twoD.pixelsPerUnit,
    projectDocument?.settings.twoD.sortingLayers,
    projectDocument?.settings.fonts.defaultFontGuid,
    projectDocument?.settings.fonts.globalFallback,
    engineEpoch,
    canvasRef,
    engineRef,
    releaseEngineRef,
    simulationDetachedRef,
    blockingLoadRef,
    loadTransitionRef,
    engineGenerationRef,
    appliedRenderSettingsRef,
    environmentSettingsRef,
    setDropReady,
    setSceneReady,
    setSceneLoad,
  ]);

  useEffect(() => () => textureSwapRef.current?.controller.abort(), []);

  // A background encode commit swaps how a Texture is stored (PNG to KTX2), not
  // what it shows, so it never reloads the scene: only the changed Textures are
  // read again and swapped in place on the live meshes and Materials.
  // Single-flight per applied asset set: a running swap is never restarted by a
  // later commit. It collects whatever changed within its paint, and goes round
  // again if the registry changed while it read. A load in flight stands the swap
  // down (it reads the latest bytes itself) and re-runs this when it finishes
  // (`dropReady`). A Texture the engine did not take (not installed yet) stays
  // pending and is retried when the registry next changes, not on every scene edit.
  useEffect(() => {
    const handle = engineRef.current;
    const applied = appliedAssetsRef.current;
    if (!handle || !applied || applied.handle !== handle || applied.key !== viewportAssetsKey || assetLoadRef.current) return;
    if (changedTextureEncodings(applied.textures, textureEncodingsRef.current).length === 0) return;
    let swap = textureSwapRef.current;
    if (!swap || swap.applied !== applied) {
      swap?.controller.abort();
      swap = textureSwapRef.current = { applied, attempted: null, running: false, controller: new AbortController() };
    }
    if (swap.running || swap.attempted === textureEncodingsRef.current) return;
    const state = swap;
    const { signal } = state.controller;
    const isCurrent = () => !signal.aborted && engineRef.current === handle &&
      appliedAssetsRef.current === applied && assetLoadRef.current === null;
    state.running = true;
    void (async () => {
      try {
        for (;;) {
          await waitForSceneLoadingPaint(signal);
          if (!isCurrent()) return;
          const encodings = textureEncodingsRef.current;
          const guids = changedTextureEncodings(applied.textures, encodings);
          if (guids.length > 0) {
            const bytes = await collectPlayTextureBytes(new Map(), new Map(), guids);
            if (!isCurrent()) return;
            // Only what the engine reports as now stored this way counts as applied.
            for (const guid of handle.replaceTextureBytes(bytes)) applied.textures.set(guid, encodings.get(guid) ?? "");
          }
          state.attempted = encodings;
          if (textureEncodingsRef.current === encodings) return;
        }
      } catch (error) {
        if (!signal.aborted) console.warn("[viewport] failed to swap Texture encodings", error);
      } finally {
        state.running = false;
      }
    })();
  }, [textureEncodingsKey, viewportAssetsKey, dropReady, engineEpoch, collectPlayTextureBytes, engineRef]);
}
