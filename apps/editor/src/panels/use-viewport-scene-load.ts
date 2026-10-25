import { useEffect, useMemo, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import {
  areaEmissionTextureGuids,
  renderEffectsAssetGuids,
  type EnvironmentLightingSettings,
  type SerializedScene,
} from "@haptic/core";
import {
  engineAdapterInfo,
  type EngineHandle,
  type EditorSceneLoadOptions,
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
  waitForSceneLoadingPaint,
  type SceneViewportLoadPhase,
} from "../lib/scene-viewport-load";

/** The Scene viewport's loading dialog and failure state. */
export interface ViewportSceneLoadState {
  open: boolean;
  progress: number;
  phase: SceneViewportLoadPhase;
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

  const textureLodKey = `${editorTextureLodEnabled}:${editorTextureLodQuality}`;
  const effectsAssetGuidsKey = JSON.stringify(renderEffectsAssetGuids(projectDocument?.settings.render.effects));
  // Depends on the registry alone, so Scene edits do not rebuild it.
  const materialLibraryKey = useMemo(() => {
    void registryEpoch;
    return savedMaterialLibraryKey(assetRegistry?.list() ?? []);
  }, [assetRegistry, registryEpoch]);
  const viewportAssetsKey = useMemo(() => {
    void registryEpoch;
    return JSON.stringify([
      sceneViewportAssetKey(scene, assetRegistry?.list() ?? []),
      textureLodKey,
      effectsAssetGuidsKey,
      projectDocument?.settings.twoD,
      projectDocument?.settings.fonts,
    ]);
  }, [
    assetRegistry,
    registryEpoch,
    scene,
    textureLodKey,
    effectsAssetGuidsKey,
    projectDocument?.settings.twoD,
    projectDocument?.settings.fonts,
  ]);
  const areaTextureGuids = useMemo(() => areaEmissionTextureGuids(scene), [scene]);
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
    setDropReady(null);
    setSceneReady(false);
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
      blockingLoadRef.current = controller;
      handle.setPaused(true);
      setSceneLoad({ open: false, progress: 0, phase: "Preparing Scene", rendering });
    }
    void (async () => {
      let collected: EditorSceneLoadOptions | null = null;
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
        const fontSources = catalog.map((asset) => ({ guid: asset.header.guid, path: asset.path, type: asset.header.type, payload: asset.header.payload }));
        const bitmapFonts = new Set(fontGuidsForSceneRepresentation([scene], fontSources, "source", projectDocument?.settings.fonts.defaultFontGuid));
        const required = sceneViewportRequiredAssets(scene, catalog, [
          ...(JSON.parse(effectsAssetGuidsKey) as string[]),
          ...bitmapFonts,
          ...fontGuidsForSceneRepresentation([scene], fontSources, "msdf", projectDocument?.settings.fonts.defaultFontGuid),
        ]);
        const sprites = await collectPlaySpritePayloads(scene);
        controller.signal.throwIfAborted();
        const tileContent = await collectPlayTilemapContent(scene);
        const waters = await collectPlayWaterContent(required);
        const renderTargetAssets = await collectPlayRenderTargets(required);
        controller.signal.throwIfAborted();
        const modelBytes = await collectPlayModelBytes(scene, [], required);
        controller.signal.throwIfAborted();
        const modelPayloads = await collectPlayModelPayloads(scene);
        controller.signal.throwIfAborted();
        const materials = await collectPlayMaterialLibrary(
          scene,
          [],
          [...modelSlotMaterialGuidsFromPayloads(modelPayloads), ...[...waters.values()].flatMap((water) => water.materialGuid ? [water.materialGuid] : [])],
        );
        controller.signal.throwIfAborted();
        const extraTextureGuids = [
          ...environmentTextureGuidsFromScenes([scene]),
          ...postProcessTextureGuidsFromScenes([scene]),
          ...materialInstanceTextureGuidsFromScenes([scene]),
          ...materials.textureGuids,
          ...skyboxFaceGuidsFromScene(scene),
          ...overlayTextureGuidsFromScene(scene),
          ...(JSON.parse(effectsAssetGuidsKey) as string[]),
        ];
        const textureBytes = await collectPlayTextureBytes(
          sprites,
          tileContent.tilesets,
          extraTextureGuids,
        );
        controller.signal.throwIfAborted();
        const texturePixelSizes = collectPlayTexturePixelSizes(
          sprites,
          tileContent.tilesets,
          extraTextureGuids,
        );
        const fontFacetypeBytes = await collectPlayFontFacetypeBytes(scene);
        const areaEmissions = await collectPlayAreaEmissions([scene]);
        controller.signal.throwIfAborted();
        const msdf = fontMsdfMapsFromPairs(
          await collectPlayFontMsdfPair(scene),
        );
        controller.signal.throwIfAborted();
        const fontFaceEntries = await collectPlayFontFaceEntries(bitmapFonts);
        const fontCss = collectPlayFontCssStacks();
        if (!isCurrent()) return;
        await handle.registerFonts(fontFaceEntries);
        if (!isCurrent()) return;
        const assets = {
          resourceCache: handle.resourceCache,
          spritePayloads: sprites,
          tilemaps: tileContent.tilemaps,
          waters,
          payloadRevisions: stableViewportPayloadRevisions(
            payloadRevisionsBefore,
            viewportPayloadRevisions(assetRegistry?.list() ?? [], getOpenDocuments()),
          ),
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
            onProgress: (progress) => {
              if (isCurrent()) setSceneLoad({ open: true, progress: 20 + 25 * progress, phase: "Realizing Scene", rendering });
            },
          };
        } else {
          handle.setMaterialDocuments(materials.documents, materials.functions);
          handle.setMeshAssets(assets);
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
            realize,
            collect: applyCollectedAssets,
            whenModelsReady: async () => {
              if (!isCurrent()) return;
              await handle.whenEditorModelsReady();
              if (!isCurrent()) return;
              await handle.whenMaterialTexturesReady();
            },
            warmShaders: async () => {
              if (!isCurrent()) return;
              await handle.prewarmSceneMaterials();
            },
            presentFirstFrame: async () => {
              if (!isCurrent()) return;
              await handle.presentFirstFrame();
            },
            onProgress: (progress, phase) => {
              if (!isCurrent()) return;
              setSceneLoad({ open: true, progress, phase, rendering });
            },
          });
        } else {
          await realize();
          await applyCollectedAssets();
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
