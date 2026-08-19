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
import type { Engine } from "@babylonjs/core";
import {
  MaterialLibrary,
  ResourceCache,
  attachMaterialPreviewGestures,
  createMaterialPreviewPresenter,
  createMaterialPreviewScene,
  getMaterialTexture,
  materialUnavailable,
  type MaterialPreviewPresenter,
  type MaterialPreviewScene,
} from "@babylonslate/render";
import {
  classifyMaterialCost,
  createMaterialPreviewState,
  lowerMaterialDocument,
  materialCompileKey,
  materialPreviewReducer,
  normalizeMaterialDocument,
  normalizeMaterialFunctionDocument,
  renderActionEnabled,
  type MaterialDiagnostic,
  type MaterialDocument,
  type MaterialFunctionDocument,
  type MaterialPreviewState,
} from "@babylonslate/shader-graph";
import { useDocuments } from "./document-context";
import { usePlay } from "./play-context";
import { registerMaterialPreviewCameraRadius } from "../lib/material-preview-test-host";
import { useMaterialRenderControl } from "./material-render-control-context";

/** Trailing debounce: the last edit always compiles, unlike a rate limiter. */
const IDLE_DEBOUNCE_MS = 220;
export const MANUAL_RENDER_COOLDOWN_MS = 3_000;

export interface MaterialEditingValue {
  /** Material Function documents in the project, keyed by asset guid. */
  functions: Record<string, MaterialFunctionDocument>;
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
  const { openDocuments, assetRegistry, projectDocument, readAssetChunk } =
    useDocuments();
  const play = usePlay();
  const { register: registerRenderControl } = useMaterialRenderControl();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const isFunctionDocument = doc?.ref.kind === "material-function";

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
  const [sharedEngine, setSharedEngine] = useState<Engine | null>(null);
  const [renderCoolingDown, setRenderCoolingDown] = useState(false);

  const hostRef = useRef<MaterialPreviewScene | null>(null);
  const presenterRef = useRef<MaterialPreviewPresenter | null>(null);
  const libraryRef = useRef<MaterialLibrary | null>(null);
  const resourceCacheRef = useRef<ResourceCache | null>(null);
  const functionsRef = useRef<Record<string, MaterialFunctionDocument>>({});
  const textureBytesRef = useRef(new Map<string, Uint8Array>());
  const engineRef = useRef<Engine | null>(null);
  const generationRef = useRef(0);
  const manualRenderPendingRef = useRef(false);
  const renderCooldownTimerRef = useRef<number | null>(null);
  const frozen = !active || play.playing;

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

  /** Material Functions the graph can call, read from open tabs or headers. */
  const functions = useMemo(() => {
    const map: Record<string, MaterialFunctionDocument> = {};
    for (const asset of assetRegistry?.list() ?? []) {
      if (asset.header.type !== "MaterialFunction") continue;
      const open = openDocuments.find(
        (entry) => entry.ref.path === asset.path && entry.content,
      );
      map[asset.header.guid] = normalizeMaterialFunctionDocument(
        open?.content ?? asset.header.payload,
      );
    }
    return map;
  }, [assetRegistry, openDocuments]);
  functionsRef.current = functions;
  engineRef.current = sharedEngine;

  // Keyed on `content`, not on the open-document entry: the store can replace
  // a document's content while keeping the entry identity, and memoizing on
  // the entry would leave the preview compiling a stale graph.
  const content = doc?.content;
  const document = useMemo<MaterialDocument | null>(() => {
    if (isFunctionDocument || content === undefined) return null;
    return normalizeMaterialDocument(content ?? {});
  }, [content, isFunctionDocument]);

  useEffect(() => {
    setSharedEngine(play?.ensureSharedEngine() ?? null);
  }, [play]);

  useEffect(() => {
    if (libraryRef.current) return;
    resourceCacheRef.current = new ResourceCache();
    libraryRef.current = new MaterialLibrary({
      functions: () => functionsRef.current,
      resolveTexture: (guid) => {
        const bytes = textureBytesRef.current.get(guid);
        const engine = engineRef.current;
        const cache = resourceCacheRef.current;
        if (!bytes || !engine || !cache) return null;
        return getMaterialTexture(cache, guid, engine, bytes);
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
      presenter = createMaterialPreviewPresenter(host, canvas);
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
    registerMaterialPreviewCameraRadius(
      () => hostRef.current?.camera.radius ?? null,
    );
    return () => {
      gestures?.dispose();
      presenter?.dispose();
      host?.dispose();
      hostRef.current = null;
      presenterRef.current = null;
      registerMaterialPreviewCameraRadius(null);
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
    if (!host || !document) return;
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
      host.setMesh(mesh, bytes);
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
    return lowered.plan.dependencies.textures.join(",");
  }, [document, functions]);
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
    void (async () => {
      const next = new Map<string, Uint8Array>();
      for (const guid of guids) {
        const asset = assetRegistry?.getByGuid(guid);
        if (!asset || !readAssetChunk) continue;
        const pixels = await readAssetChunk(asset.path, "pixels");
        if (pixels && pixels.byteLength > 0) {
          next.set(guid, pixels);
          continue;
        }
        const source = await readAssetChunk(asset.path, "source");
        if (source && source.byteLength > 0) next.set(guid, source);
      }
      if (cancelled) return;
      textureBytesRef.current = next;
      setLoadedTextureGuidsKey(textureGuidsKey);
    })();
    return () => {
      cancelled = true;
    };
  }, [assetRegistry, readAssetChunk, textureGuidsKey]);

  // Keyed on the lowered plan hash (positions excluded), not document identity.
  const costClassRef = useRef(costClass);
  costClassRef.current = costClass;
  useEffect(() => {
    if (!compileKey) return;
    generationRef.current += 1;
    dispatch({ type: "edit", cost: costClassRef.current });
  }, [compileKey]);

  // Trailing debounce so the final edit still compiles.
  useEffect(() => {
    if (previewState.status !== "dirty") return;
    const timer = window.setTimeout(() => dispatch({ type: "idle" }), IDLE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [previewState.status, previewState.generation]);

  const compile = useCallback(
    (generation: number) => {
      const host = hostRef.current;
      const library = libraryRef.current;
      if (!host || !library || !document) return;
      dispatch({ type: "compileStart", generation });
      const started = performance.now();
      const result = library.acquire(host.scene, documentId, document);
      const durationMs = performance.now() - started;
      if (materialUnavailable(result)) {
        setCompileDiagnostics(result.diagnostics);
        dispatch({
          type: "result",
          generation,
          ok: false,
          durationMs,
          error: result.diagnostics[0]?.message,
        });
        finishManualRender();
        return;
      }
      setCompileDiagnostics([]);
      if (document.domain === "postProcess" || document.domain === "interface") {
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
    const generation = previewState.queuedGeneration ?? previewState.generation;
    // Yield so the pointer/keyboard event that queued this can finish first.
    const handle = window.setTimeout(() => compile(generation), 0);
    return () => window.clearTimeout(handle);
  }, [
    compile,
    previewState.generation,
    previewState.queuedGeneration,
    previewState.status,
    texturesReady,
  ]);

  useEffect(() => {
    return () => {
      if (renderCooldownTimerRef.current !== null) {
        window.clearTimeout(renderCooldownTimerRef.current);
      }
      libraryRef.current?.dispose();
      libraryRef.current = null;
      resourceCacheRef.current?.dispose();
      resourceCacheRef.current = null;
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
    });
  }, [
    active,
    documentId,
    isFunctionDocument,
    registerRenderControl,
    renderDisabled,
    requestRender,
  ]);

  const value = useMemo<MaterialEditingValue>(
    () => ({
      functions,
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
      focusedNodeId,
      frameBudgetMs,
      functions,
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
