import { installedAssetIdentity, type IndexedAsset } from "@babylonslate/assets";
import { installTextureBytes } from "@babylonslate/render";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AbstractEngine } from "@babylonjs/core";
import {
  MaterialLibrary,
  attachMaterialPreviewGestures,
  createMaterialPreviewPresenter,
  createMaterialPreviewScene,
  setSceneRenderSettings,
  acquireMaterialTexture,
  installPreviewEnvironment,
  materialUnavailable,
  resourceCacheForEngine,
  type MaterialPreviewPresenter,
  type MaterialPreviewScene,
} from "@babylonslate/render";
import {
  classifyMaterialCost,
  createMaterialPreviewState,
  lowerMaterialDocument,
  materialCompileKey,
  materialParameterDefaults,
  materialPreviewReducer,
  normalizeMaterialDocument,
  normalizeMaterialFunctionDocument,
  normalizeMaterialInstanceDocument,
  renderActionEnabled,
  resolveMaterialInstance,
  type MaterialDiagnostic,
  type MaterialDocument,
  type MaterialDomain,
  type MaterialFunctionDocument,
  type MaterialInstanceDocument,
  type MaterialPreviewState,
} from "@babylonslate/shader-graph";
import type { MaterialParameterValue } from "@babylonslate/core";
import { useDocuments } from "./document-context";
import { usePlay } from "./play-context";
import { useMaterialRenderControl } from "./material-render-control-context";
import { useMaterialInstanceSources } from "./material-instance-sources";

/** Trailing debounce: the last edit always compiles, unlike a rate limiter. */
const IDLE_DEBOUNCE_MS = 220;
export const MANUAL_RENDER_COOLDOWN_MS = 3_000;

/** A parameter the root Material exposes, with the value this instance inherits. */
export interface MaterialInstanceParameter {
  name: string;
  inherited: MaterialParameterValue;
}

export interface MaterialInstanceEditing {
  document: MaterialInstanceDocument;
  status: "loading" | "ready" | "error";
  error: string | null;
  rootGuid: string | null;
  domain: MaterialDomain | null;
  parameters: MaterialInstanceParameter[];
}

export interface MaterialEditingValue {
  /** Material Function documents in the project, keyed by asset guid. */
  functions: Record<string, MaterialFunctionDocument>;
  /** Domain of the previewed graph (a Material Instance previews its root's). */
  previewDomain: MaterialDomain | null;
  /** Set only for Material Instance documents. */
  instance: MaterialInstanceEditing | null;
  previewState: MaterialPreviewState;
  compileDiagnostics: MaterialDiagnostic[];
  selectedNodeId: string | null;
  setSelectedNodeId: (nodeId: string | null) => void;
  focusedNodeId: string | null;
  focusNode: (nodeId: string) => void;
  requestRender: () => void;
  attachPreviewCanvas: (canvas: HTMLCanvasElement | null) => void;
  frameBudgetMs: number;
}

const MaterialEditingContext = createContext<MaterialEditingValue | null>(null);

export function useMaterialEditing(): MaterialEditingValue {
  const value = useContext(MaterialEditingContext);
  if (!value) {
    throw new Error("useMaterialEditing must be used inside MaterialEditingProvider");
  }
  return value;
}

/**
 * Owns the Material preview for one document tab.
 *
 * The preview Scene lives on the app-lifetime Engine but presents through an
 * RTT + 2D blit — never `registerView` or default-framebuffer `scene.render()`,
 * which would overwrite the Scene viewport and Play overlay. Compilation is
 * generation safe: an edit during a compile is never dropped, and a stale
 * result never replaces a newer one.
 */
export function MaterialEditingProvider({
  documentId,
  active = true,
  children,
}: {
  documentId: string;
  active?: boolean;
  children: ReactNode;
}) {
  const { openDocuments, assetRegistry, registryEpoch, projectDocument, readAssetChunk } =
    useDocuments();
  const play = usePlay();
  const { register: registerRenderControl } = useMaterialRenderControl();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const isFunctionDocument = doc?.ref.kind === "material-function";
  const isInstanceDocument = doc?.ref.kind === "material-instance";

  const [previewState, dispatch] = useReducer(
    materialPreviewReducer,
    undefined,
    createMaterialPreviewState,
  );
  const [compileDiagnostics, setCompileDiagnostics] = useState<
    MaterialDiagnostic[]
  >([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [sharedEngine, setSharedEngine] = useState<AbstractEngine | null>(null);
  const [renderCoolingDown, setRenderCoolingDown] = useState(false);

  const hostRef = useRef<MaterialPreviewScene | null>(null);
  const presenterRef = useRef<MaterialPreviewPresenter | null>(null);
  const libraryRef = useRef<MaterialLibrary | null>(null);
  const functionsRef = useRef<Record<string, MaterialFunctionDocument>>({});
  const textureBytesRef = useRef<ReadonlyMap<string, Uint8Array | Blob>>(new Map());
  const engineRef = useRef<AbstractEngine | null>(null);
  const generationRef = useRef(0);
  const manualRenderPendingRef = useRef(false);
  const renderCooldownTimerRef = useRef<number | null>(null);
  const [previewSceneEpoch, setPreviewSceneEpoch] = useState(0);
  const frozen = !active || play.playing;
  useEffect(() => {
    const host = hostRef.current;
    if (host) {
      setSceneRenderSettings(host.scene, projectDocument?.settings.render ?? {});
      if (!frozen) presenterRef.current?.present({ force: true });
    }
  }, [projectDocument?.settings.render, previewSceneEpoch, frozen]);

  const finishManualRender = useCallback(() => {
    if (!manualRenderPendingRef.current) return;
    manualRenderPendingRef.current = false;
    setRenderCoolingDown(true);
    if (renderCooldownTimerRef.current !== null) {
      window.clearTimeout(renderCooldownTimerRef.current);
    }
    renderCooldownTimerRef.current = window.setTimeout(() => {
      renderCooldownTimerRef.current = null;
      setRenderCoolingDown(false);
    }, MANUAL_RENDER_COOLDOWN_MS);
  }, []);

  const frameBudgetMs =
    1000 / Math.max(1, projectDocument?.settings.playFrameCap ?? 60);

  const functionAssetsRef = useRef<IndexedAsset[]>([]);
  const functionAssets = useMemo(() => {
    void registryEpoch; // Registry contents mutate without replacing its instance.
    const next = (assetRegistry?.list() ?? []).filter(
      (asset) => asset.header.type === "MaterialFunction",
    );
    const previous = functionAssetsRef.current;
    if (
      previous.length === next.length &&
      next.every((asset, index) => asset === previous[index])
    ) {
      return previous;
    }
    functionAssetsRef.current = next;
    return next;
  }, [assetRegistry, registryEpoch]);
  const [savedFunctions, setSavedFunctions] = useState<Record<string, MaterialFunctionDocument>>({});
  const [loadedFunctionAssets, setLoadedFunctionAssets] = useState<typeof functionAssets | null>(null);
  const functionsReady = functionAssets.length === 0 || loadedFunctionAssets === functionAssets;
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next: Record<string, MaterialFunctionDocument> = {};
      for (const asset of functionAssets) {
        try {
          const bytes = await readAssetChunk?.(asset.path, "document");
          const content = bytes?.length ? JSON.parse(new TextDecoder().decode(bytes)) : asset.header.payload;
          // Missing bodies stay missing so validation can report the call site.
          if (content && typeof content === "object" && Array.isArray((content as Record<string, unknown>).nodes)) {
            next[asset.header.guid] = normalizeMaterialFunctionDocument(content);
          }
        } catch {
          // An unavailable function is diagnosed by graph validation.
        }
      }
      if (!cancelled) { setSavedFunctions(next); setLoadedFunctionAssets(functionAssets); }
    })();
    return () => { cancelled = true; };
  }, [functionAssets, readAssetChunk]);

  /** Open edits override saved document chunks; headers are only legacy fallback. */
  const functions = useMemo(() => {
    const map: Record<string, MaterialFunctionDocument> = { ...savedFunctions };
    for (const asset of functionAssets) {
      const open = openDocuments.find(
        (entry) => entry.ref.path === asset.path && entry.content,
      );
      if (open?.content) map[asset.header.guid] = normalizeMaterialFunctionDocument(open.content);
    }
    return map;
  }, [functionAssets, openDocuments, savedFunctions]);
  functionsRef.current = functions;
  engineRef.current = sharedEngine;

  // Keyed on `content`, not on the open-document entry: the store can replace
  // a document's content while keeping the entry identity, and memoizing on
  // the entry would leave the preview compiling a stale graph.
  const content = doc?.content;
  const instanceDocument = useMemo<MaterialInstanceDocument | null>(
    () => isInstanceDocument && content !== undefined ? normalizeMaterialInstanceDocument(content ?? {}) : null,
    [content, isInstanceDocument],
  );
  const instanceSources = useMaterialInstanceSources(documentId, instanceDocument?.parentGuid ?? null);
  const instanceResolution = useMemo(() => {
    if (!instanceDocument || !instanceSources) return null;
    return resolveMaterialInstance(documentId, (guid) =>
      guid === documentId ? { kind: "instance", document: instanceDocument } : instanceSources.get(guid) ?? null);
  }, [documentId, instanceDocument, instanceSources]);
  // An instance compiles its root graph once; its own and inherited overrides
  // are uniform writes on that material, so value edits never recompile.
  const document = useMemo<MaterialDocument | null>(() => {
    if (isFunctionDocument || content === undefined) return null;
    if (isInstanceDocument) {
      return instanceResolution?.ok
        ? { ...instanceResolution.root, preview: instanceDocument!.preview, instanceOf: instanceResolution.rootGuid }
        : null;
    }
    return normalizeMaterialDocument(content ?? {});
  }, [content, instanceDocument, instanceResolution, isFunctionDocument, isInstanceDocument]);
  const instanceOverrides = instanceResolution?.ok ? instanceResolution.overrides : null;

  useEffect(() => {
    setSharedEngine(play?.ensureSharedEngine() ?? null);
  }, [play]);

  useEffect(() => {
    if (libraryRef.current) return;
    libraryRef.current = new MaterialLibrary({
      textureIdentity: (guid) => { const source = textureBytesRef.current.get(guid); return source instanceof Blob ? installedAssetIdentity(source) : undefined; },
      particlePreview: true,
      functions: () => functionsRef.current,
      acquireTexture: (guid) => {
        const bytes = textureBytesRef.current.get(guid);
        const engine = engineRef.current;
        return bytes && engine ? acquireMaterialTexture(resourceCacheForEngine(engine), guid, engine, bytes) : null;
      },
    });
  }, []);

  // One preview Scene per tab, presented to a 2D canvas via RTT.
  useEffect(() => {
    if (!sharedEngine || !canvas) return;
    let host: MaterialPreviewScene | null = null;
    let presenter: MaterialPreviewPresenter | null = null;
    let gestures: { dispose: () => void } | null = null;
    try {
      host = createMaterialPreviewScene(sharedEngine, {
        mesh: document?.preview.mesh ?? "cube",
      });
      installPreviewEnvironment(host.scene);
      presenter = createMaterialPreviewPresenter(host, canvas, {
        onError: (message) => {
          dispatch({ type: "previewError", error: message });
          if (message) {
            console.warn(`[render] Material preview presentation failed: ${message}`);
          }
        },
      });
      presenter.setFrozen(frozen);
      gestures = attachMaterialPreviewGestures(canvas, host.camera);
    } catch {
      gestures?.dispose();
      presenter?.dispose();
      host?.dispose();
      return;
    }
    hostRef.current = host;
    presenterRef.current = presenter;
    setPreviewSceneEpoch((current) => current + 1);
    return () => {
      gestures?.dispose();
      presenter?.dispose();
      if (host) libraryRef.current?.releaseScene(host.scene);
      host?.dispose();
      hostRef.current = null;
      presenterRef.current = null;
      dispatch({ type: "dispose" });
    };
    // Mesh choice is applied in the effect below; freeze is pushed separately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas, sharedEngine]);

  useEffect(() => {
    presenterRef.current?.setFrozen(frozen);
    if (frozen) return;
    const presenter = presenterRef.current;
    if (!presenter) return;
    let frame = 0;
    const tick = () => {
      presenter.present();
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [frozen, canvas, sharedEngine]);

  // Keep the preview primitive in step with the document.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !document || document.domain === "particle") return;
    const mesh = document.preview.mesh;
    const guid = document.preview.customMeshGuid;
    let cancelled = false;
    void (async () => {
      let bytes: Uint8Array | null = null;
      if (mesh === "custom" && guid) {
        const asset = assetRegistry?.getByGuid(guid);
        if (asset && readAssetChunk) {
          bytes = await readAssetChunk(asset.path, "source");
        }
      }
      if (cancelled) return;
      await host.setMesh(mesh, bytes);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    assetRegistry,
    canvas,
    document?.preview.customMeshGuid,
    document?.preview.mesh,
    readAssetChunk,
  ]);

  const costClass = useMemo(() => {
    if (!document) return "cheap" as const;
    const lowered = lowerMaterialDocument(document, { functions });
    if (!lowered.ok) return "expensive" as const;
    return classifyMaterialCost(lowered.plan.cost, {
      frameBudgetMs,
      domain: document.domain,
      observedCompileMs: previewState.compileSamplesMs,
    });
    // `compileSamplesMs` deliberately participates: measured timings refine
    // the policy as the session goes on.
  }, [document, frameBudgetMs, functions, previewState.compileSamplesMs]);

  const compileKey = useMemo(() => {
    if (!document) return null;
    return materialCompileKey(document, { functions });
  }, [document, functions]);

  const textureGuidsKey = useMemo(() => {
    if (!document) return "";
    const lowered = lowerMaterialDocument(document, { functions });
    if (!lowered.ok) return "";
    const overrideTextures = Object.values(instanceOverrides ?? {}).flatMap((value) =>
      value.kind === "texture" && value.textureAssetGuid ? [value.textureAssetGuid] : []);
    return [...new Set([...lowered.plan.dependencies.textures, ...overrideTextures])].sort().join(",");
  }, [document, functions, instanceOverrides]);
  const [loadedTextureGuidsKey, setLoadedTextureGuidsKey] = useState("");
  const texturesReady =
    textureGuidsKey === "" || textureGuidsKey === loadedTextureGuidsKey;

  useEffect(() => {
    const guids = textureGuidsKey === "" ? [] : textureGuidsKey.split(",");
    if (guids.length === 0) {
      textureBytesRef.current = new Map();
      setLoadedTextureGuidsKey("");
      return;
    }
    let cancelled = false;
    setLoadedTextureGuidsKey("");
    void (async () => {
      const next = new Map<string, Uint8Array>();
      for (const guid of guids) {
        const asset = assetRegistry?.getByGuid(guid);
        if (!asset || asset.header.type === "RenderTargetTexture" || !readAssetChunk) continue;
        const pixels = await readAssetChunk(asset.path, "pixels");
        if (pixels && pixels.byteLength > 0) {
          next.set(guid, pixels);
          continue;
        }
        const source = await readAssetChunk(asset.path, "source");
        if (source && source.byteLength > 0) next.set(guid, source);
      }
      if (cancelled) return;
      textureBytesRef.current = installTextureBytes(next) ?? new Map();
      libraryRef.current?.markDirty();
      setLoadedTextureGuidsKey(textureGuidsKey);
      dispatch({ type: "edit", cost: costClassRef.current });
    })();
    return () => {
      cancelled = true;
    };
  }, [assetRegistry, registryEpoch, readAssetChunk, textureGuidsKey]);

  const costClassRef = useRef(costClass);
  costClassRef.current = costClass;

  const rootParameters = useMemo(() => {
    if (!isInstanceDocument || !document) return null;
    const lowered = lowerMaterialDocument(document, { functions });
    return lowered.ok ? materialParameterDefaults(lowered.plan) : null;
  }, [document, functions, isInstanceDocument]);

  /** Push the merged overrides as uniform/texture writes; unset names return to the root default. */
  const applyInstanceParameters = useCallback(() => {
    const host = hostRef.current;
    const library = libraryRef.current;
    if (!host || !library || !rootParameters || !instanceOverrides) return;
    for (const [name, fallback] of Object.entries(rootParameters)) {
      const value = instanceOverrides[name];
      if (value?.kind === fallback.kind) library.setParameter(host.scene, documentId, name, value);
      else library.resetParameter(host.scene, documentId, name);
    }
  }, [documentId, instanceOverrides, rootParameters]);
  const applyInstanceParametersRef = useRef(applyInstanceParameters);
  applyInstanceParametersRef.current = applyInstanceParameters;
  useEffect(() => {
    if (texturesReady) applyInstanceParameters();
  }, [applyInstanceParameters, previewState.readyGeneration, texturesReady]);

  useEffect(() => {
    const restored = sharedEngine?.onContextRestoredObservable;
    if (!restored?.add) return;
    const observer = restored.add(() => {
      libraryRef.current?.invalidate();
      if (!compileKey) return;
      dispatch({ type: "edit", cost: costClassRef.current });
      presenterRef.current?.present({ force: true });
    });
    return () => {
      restored.remove(observer);
    };
  }, [compileKey, sharedEngine]);

  useEffect(() => {
    if (!compileKey) return;
    generationRef.current += 1;
    const host = hostRef.current;
    if (host) libraryRef.current?.cancelPending(host.scene, documentId);
    dispatch({ type: "edit", cost: costClassRef.current });
  }, [compileKey, documentId, previewSceneEpoch]);

  useEffect(() => {
    hostRef.current?.applyParticleMaterial?.(null);
    hostRef.current?.applyPostProcess(null);
  }, [document?.domain]);

  // Trailing debounce so the final edit still compiles.
  useEffect(() => {
    if (previewState.status !== "dirty") return;
    const timer = window.setTimeout(() => dispatch({ type: "idle" }), IDLE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [previewState.status, previewState.generation]);

  const compile = useCallback(
    async (generation: number) => {
      const host = hostRef.current;
      const library = libraryRef.current;
      if (!host || !library || !document) return;
      dispatch({ type: "compileStart", generation });
      const started = performance.now();
      const editGeneration = generationRef.current;
      const previous = library.materialFor(host.scene, documentId);
      const result = library.acquire(host.scene, documentId, document);
      if (previous && !materialUnavailable(result)) library.release(host.scene, documentId);
      const errors = materialUnavailable(result) ? result.diagnostics : await result.ready;
      if (hostRef.current !== host || generationRef.current !== editGeneration) return;
      const durationMs = performance.now() - started;
      if (materialUnavailable(result) || errors.length) {
        setCompileDiagnostics([...errors]);
        dispatch({
          type: "result",
          generation,
          ok: false,
          durationMs,
          error: errors[0]?.message,
        });
        finishManualRender();
        return;
      }
      setCompileDiagnostics([]);
      applyInstanceParametersRef.current();
      host.applyParticleMaterial?.(document.domain === "particle" ? result.material : null);
      if (document.domain === "postProcess") {
        host.applyMaterial(null);
        host.applyPostProcess(result.material);
      } else if (document.domain === "particle") {
        host.applyMaterial(null);
        host.applyPostProcess(null);
      } else {
        host.applyPostProcess(null);
        host.applyMaterial(result.material);
      }
      dispatch({ type: "result", generation, ok: true, durationMs });
      finishManualRender();
    },
    [document, documentId, finishManualRender],
  );

  // Compile whatever the state machine queued, after Texture bytes are ready.
  useEffect(() => {
    if (previewState.status !== "queued") return;
    if (!texturesReady) return;
    if (!functionsReady) return;
    if (!hostRef.current) return;
    const generation = previewState.queuedGeneration ?? previewState.generation;
    // Yield so the pointer/keyboard event that queued this can finish first.
    const handle = window.setTimeout(() => compile(generation), 0);
    return () => window.clearTimeout(handle);
  }, [
    compile,
    previewSceneEpoch,
    previewState.generation,
    previewState.queuedGeneration,
    previewState.status,
    texturesReady,
    functionsReady,
  ]);

  useEffect(() => {
    return () => {
      if (renderCooldownTimerRef.current !== null) {
        window.clearTimeout(renderCooldownTimerRef.current);
      }
      libraryRef.current?.dispose();
      libraryRef.current = null;
    };
  }, []);

  const renderDisabled =
    frozen ||
    isFunctionDocument ||
    !document ||
    !canvas ||
    !sharedEngine ||
    renderCoolingDown ||
    !renderActionEnabled(previewState);
  const requestRender = useCallback(() => {
    if (renderDisabled) return;
    manualRenderPendingRef.current = true;
    dispatch({ type: "render" });
  }, [renderDisabled]);

  useEffect(() => {
    if (!active || isFunctionDocument) return;
    return registerRenderControl(documentId, {
      disabled: renderDisabled,
      requestRender,
      feedback: {
        status: !renderActionEnabled(previewState) ? "pending"
          : previewState.lastError ? "error"
            : renderCoolingDown && previewState.status === "ready" ? "success" : "idle",
        message: renderActionEnabled(previewState) ? previewState.lastError ?? undefined : undefined,
      },
    });
  }, [
    active,
    documentId,
    isFunctionDocument,
    registerRenderControl,
    renderDisabled,
    previewState,
    renderCoolingDown,
    requestRender,
  ]);

  const instance = useMemo<MaterialInstanceEditing | null>(() => {
    if (!instanceDocument) return null;
    const parentOverrides = instanceSources && instanceDocument.parentGuid
      ? resolveMaterialInstance(instanceDocument.parentGuid, (guid) => instanceSources.get(guid) ?? null)
      : null;
    const inherited = parentOverrides?.ok ? parentOverrides.overrides : {};
    return {
      document: instanceDocument,
      status: !instanceDocument.parentGuid || instanceResolution?.ok === false ? "error"
        : instanceResolution?.ok && rootParameters ? "ready" : "loading",
      error: !instanceDocument.parentGuid ? "Pick a parent Material to edit its parameters."
        : instanceResolution?.ok === false ? instanceResolution.message : null,
      rootGuid: instanceResolution?.ok ? instanceResolution.rootGuid : null,
      domain: document?.domain ?? null,
      parameters: Object.entries(rootParameters ?? {}).map(([name, fallback]) => ({
        name,
        inherited: inherited[name]?.kind === fallback.kind ? inherited[name]! : fallback,
      })),
    };
  }, [document?.domain, instanceDocument, instanceResolution, instanceSources, rootParameters]);

  const value = useMemo<MaterialEditingValue>(
    () => ({
      functions,
      previewDomain: document?.domain ?? null,
      instance,
      previewState,
      compileDiagnostics,
      selectedNodeId,
      setSelectedNodeId,
      focusedNodeId,
      focusNode: (nodeId: string) => setFocusedNodeId(nodeId),
      requestRender,
      attachPreviewCanvas: setCanvas,
      frameBudgetMs,
    }),
    [
      compileDiagnostics,
      document?.domain,
      focusedNodeId,
      frameBudgetMs,
      functions,
      instance,
      previewState,
      requestRender,
      selectedNodeId,
    ],
  );

  return (
    <MaterialEditingContext.Provider value={value}>
      {children}
    </MaterialEditingContext.Provider>
  );
}
