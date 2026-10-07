import { installedAssetIdentity, type IndexedAsset } from "@babylonslate/assets";
import { encodeRgbaPng, installTextureBytes } from "@babylonslate/render";
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
  materialDependencies,
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
import {
  useDocumentActions,
  useProjectState,
  useRegistryState,
  useOpenDocument,
} from "./document-context";
import { usePlay } from "./play-context";
import { useMaterialRenderControl } from "./material-render-control-context";
import { useMaterialInstanceSources } from "./material-instance-sources";
import { useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";
import { textureUploadSignature } from "../lib/texture-upload-signature";

const FUNCTION_KINDS = ["material-function"] as const;

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
  const { readAssetChunk } = useDocumentActions();
  const { assetRegistry, registryEpoch } = useRegistryState();
  const { projectDocument } = useProjectState();
  const play = usePlay();
  const { register: registerRenderControl } = useMaterialRenderControl();
  const doc = useOpenDocument(documentId);
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

  // Keyed on `content`, not on the open-document entry: the store can replace
  // a document's content while keeping the entry identity, and memoizing on
  // the entry would leave the preview compiling a stale graph.
  const content = doc?.content;
  const hasContent = content != null;
  const instanceDocument = useMemo<MaterialInstanceDocument | null>(
    () => isInstanceDocument && content != null ? normalizeMaterialInstanceDocument(content ?? {}) : null,
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
    if (isFunctionDocument || content == null) return null;
    if (isInstanceDocument) {
      return instanceResolution?.ok
        ? { ...instanceResolution.root, preview: instanceDocument!.preview, instanceOf: instanceResolution.rootGuid }
        : null;
    }
    return normalizeMaterialDocument(content ?? {});
  }, [content, instanceDocument, instanceResolution, isFunctionDocument, isInstanceDocument]);
  const instanceOverrides = instanceResolution?.ok ? instanceResolution.overrides : null;

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
  const openFunctionDocuments = useOpenDocumentsOfKinds(FUNCTION_KINDS);
  const functionDocumentsRef = useRef<ReadonlyArray<readonly [string, unknown]>>([]);
  const functionDocuments = useMemo(() => {
    const next = openFunctionDocuments.filter((entry) => entry.content).map((entry) => [entry.ref.path, entry.content] as const);
    const previous = functionDocumentsRef.current;
    if (previous.length === next.length && next.every(([path, content], index) =>
      previous[index]![0] === path && previous[index]![1] === content)) return previous;
    functionDocumentsRef.current = next;
    return next;
  }, [openFunctionDocuments]);
  const functionRoot = isFunctionDocument && content != null ? normalizeMaterialFunctionDocument(content) : document;
  const functionRootsKey = JSON.stringify(functionRoot ? materialDependencies(functionRoot).functions : []);
  const [savedFunctions, setSavedFunctions] = useState<Record<string, MaterialFunctionDocument>>({});
  const [loadedFunctions, setLoadedFunctions] = useState<{ assets: typeof functionAssets; roots: string } | null>(null);
  const functionsReady = functionRootsKey === "[]" ||
    (loadedFunctions?.assets === functionAssets && loadedFunctions.roots === functionRootsKey);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next: Record<string, MaterialFunctionDocument> = {};
      const visited = new Set<string>();
      const pending = JSON.parse(functionRootsKey) as string[];
      while (pending.length && !cancelled) {
        const guid = pending.pop()!;
        if (visited.has(guid)) continue;
        visited.add(guid);
        const asset = functionAssets.find((entry) => entry.header.guid === guid);
        if (!asset) continue;
        try {
          let functionContent = functionDocuments.find(([path]) => path === asset.path)?.[1];
          if (!functionContent) {
            const bytes = await readAssetChunk?.(asset.path, "document", { ownerDocumentId: documentId });
            functionContent = bytes?.length ? JSON.parse(new TextDecoder().decode(bytes)) : asset.header.payload;
          }
          if (functionContent && typeof functionContent === "object" && Array.isArray((functionContent as Record<string, unknown>).nodes)) {
            const fn = normalizeMaterialFunctionDocument(functionContent);
            next[guid] = fn;
            pending.push(...materialDependencies(fn).functions);
          }
        } catch {
          // An unavailable function is diagnosed by graph validation.
        }
      }
      if (!cancelled) { setSavedFunctions(next); setLoadedFunctions({ assets: functionAssets, roots: functionRootsKey }); }
    })();
    return () => { cancelled = true; };
  }, [documentId, functionAssets, functionDocuments, functionRootsKey, readAssetChunk]);
  const functions = savedFunctions;
  functionsRef.current = functions;
  engineRef.current = sharedEngine;

  useEffect(() => {
    setSharedEngine(hasContent ? play?.ensureSharedEngine() ?? null : null);
  }, [play, hasContent]);

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
          bytes = await readAssetChunk(asset.path, "source", { ownerDocumentId: documentId });
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
    documentId,
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

  const costClassRef = useRef(costClass);
  costClassRef.current = costClass;
  const invalidatePreview = useCallback(() => {
    generationRef.current += 1;
    const host = hostRef.current;
    if (host) libraryRef.current?.cancelPending(host.scene, documentId);
    dispatch({ type: "edit", cost: costClassRef.current });
    // A cold dependency completing is part of the requested Render. Keep that
    // request queued even when this graph is too expensive for auto-preview.
    if (manualRenderPendingRef.current) dispatch({ type: "render" });
  }, [documentId]);

  const textureGuidsKey = useMemo(() => {
    if (!document) return "";
    const lowered = lowerMaterialDocument(document, { functions });
    if (!lowered.ok) return "";
    const overrideTextures = Object.values(instanceOverrides ?? {}).flatMap((value) =>
      value.kind === "texture" && value.textureAssetGuid ? [value.textureAssetGuid] : []);
    return [...new Set([...lowered.plan.dependencies.textures, ...overrideTextures])].sort().join(",");
  }, [document, functions, instanceOverrides]);
  const textureSourcesKey = useMemo(() => {
    void registryEpoch;
    return JSON.stringify((textureGuidsKey ? textureGuidsKey.split(",") : []).map((guid) => {
      const asset = assetRegistry?.getByGuid(guid);
      return asset ? [guid, asset.path, asset.header.type, textureUploadSignature(asset.header)] : [guid, "missing"];
    }));
  }, [assetRegistry, registryEpoch, textureGuidsKey]);
  const [loadedTextureSourcesKey, setLoadedTextureSourcesKey] = useState("");
  const texturesReady =
    textureGuidsKey === "" || textureSourcesKey === loadedTextureSourcesKey;

  useEffect(() => {
    const guids = textureGuidsKey === "" ? [] : textureGuidsKey.split(",");
    if (guids.length === 0) {
      textureBytesRef.current = new Map();
      setLoadedTextureSourcesKey("");
      return;
    }
    let cancelled = false;
    setLoadedTextureSourcesKey("");
    void (async () => {
      const next = new Map<string, Uint8Array>();
      for (const guid of guids) {
        const asset = assetRegistry?.getByGuid(guid);
        if (!asset) continue;
        if (asset.header.type === "RenderTargetTexture") {
          // This preview has no scene capture; RTT samples use opaque black.
          next.set(guid, encodeRgbaPng(1, 1, new Uint8Array([0, 0, 0, 255])));
          continue;
        }
        if (!readAssetChunk) continue;
        const pixels = await readAssetChunk(asset.path, "pixels", { ownerDocumentId: documentId });
        if (pixels && pixels.byteLength > 0) {
          next.set(guid, pixels);
          continue;
        }
        const source = await readAssetChunk(asset.path, "source", { ownerDocumentId: documentId });
        if (source && source.byteLength > 0) next.set(guid, source);
      }
      if (cancelled) return;
      textureBytesRef.current = installTextureBytes(next) ?? new Map();
      libraryRef.current?.markDirty();
      setLoadedTextureSourcesKey(textureSourcesKey);
      invalidatePreview();
    })();
    return () => {
      cancelled = true;
    };
  }, [assetRegistry, documentId, invalidatePreview, readAssetChunk, textureGuidsKey, textureSourcesKey]);

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
      const override = value?.kind === fallback.kind ? value : null;
      if (override) library.setParameter(host.scene, documentId, name, override);
      else library.resetParameter(host.scene, documentId, name);
      // A previewed post-process pass owns its own graph instance.
      host.setPostProcessParameter(name, override);
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
      invalidatePreview();
      presenterRef.current?.present({ force: true });
    });
    return () => {
      restored.remove(observer);
    };
  }, [compileKey, invalidatePreview, sharedEngine]);

  useEffect(() => {
    if (!compileKey) return;
    invalidatePreview();
  }, [compileKey, invalidatePreview, previewSceneEpoch]);

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
      host.applyParticleMaterial?.(document.domain === "particle" ? result.material : null);
      if (document.domain === "postProcess") {
        host.applyMaterial(null);
        host.applyPostProcess({ library, materialGuid: documentId, document });
      } else if (document.domain === "particle") {
        host.applyMaterial(null);
        host.applyPostProcess(null);
      } else {
        host.applyPostProcess(null);
        host.applyMaterial(result.material);
      }
      applyInstanceParametersRef.current();
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
