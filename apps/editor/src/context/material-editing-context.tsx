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
  createMaterialPreviewScene,
  materialUnavailable,
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
  type MaterialDiagnostic,
  type MaterialDocument,
  type MaterialFunctionDocument,
  type MaterialPreviewState,
} from "@babylonslate/shader-graph";
import { useDocuments } from "./document-context";
import { usePlay } from "./play-context";

/** Trailing debounce: the last edit always compiles, unlike a rate limiter. */
const IDLE_DEBOUNCE_MS = 220;

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
 * The preview renders on the app-lifetime Engine through an extra Scene and
 * registered view, never a second WebGL context. Compilation is generation
 * safe: an edit during a compile is never dropped, and a stale result never
 * replaces a newer one.
 */
export function MaterialEditingProvider({
  documentId,
  children,
}: {
  documentId: string;
  children: ReactNode;
}) {
  const { openDocuments, assetRegistry, projectDocument, readAssetChunk } =
    useDocuments();
  const play = usePlay();
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

  const hostRef = useRef<MaterialPreviewScene | null>(null);
  const libraryRef = useRef<MaterialLibrary | null>(null);
  const generationRef = useRef(0);

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
    if (!libraryRef.current) {
      libraryRef.current = new MaterialLibrary({ functions: () => functions });
    }
  }, [functions]);

  // One preview Scene per tab, on the shared Engine.
  useEffect(() => {
    if (!sharedEngine || !canvas) return;
    let host: MaterialPreviewScene | null = null;
    try {
      sharedEngine.registerView(canvas, undefined, true);
      host = createMaterialPreviewScene(sharedEngine, {
        mesh: document?.preview.mesh ?? "sphere",
      });
      host.camera.attachControl(canvas, true);
    } catch {
      host?.dispose();
      return;
    }
    hostRef.current = host;
    const render = () => {
      if (!host) return;
      sharedEngine.activeView = sharedEngine.views.find(
        (view) => view.target === canvas,
      );
      host.scene.render();
    };
    const resize = () => {
      if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
        sharedEngine.resize();
      }
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    sharedEngine.runRenderLoop(render);
    return () => {
      observer.disconnect();
      sharedEngine.stopRenderLoop(render);
      sharedEngine.unRegisterView(canvas);
      host?.dispose();
      hostRef.current = null;
      dispatch({ type: "dispose" });
    };
  }, [canvas, sharedEngine]);

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
        return;
      }
      setCompileDiagnostics([]);
      if (document.domain === "postProcess") {
        host.applyMaterial(null);
        host.applyPostProcess(result.material);
      } else {
        host.applyPostProcess(null);
        host.applyMaterial(result.material);
      }
      dispatch({ type: "result", generation, ok: true, durationMs });
    },
    [document, documentId],
  );

  // Compile whatever the state machine queued.
  useEffect(() => {
    if (previewState.status !== "queued") return;
    const generation = previewState.queuedGeneration ?? previewState.generation;
    // Yield so the pointer/keyboard event that queued this can finish first.
    const handle = window.setTimeout(() => compile(generation), 0);
    return () => window.clearTimeout(handle);
  }, [compile, previewState.generation, previewState.queuedGeneration, previewState.status]);

  useEffect(() => {
    return () => {
      libraryRef.current?.dispose();
      libraryRef.current = null;
    };
  }, []);

  const value = useMemo<MaterialEditingValue>(
    () => ({
      functions,
      previewState,
      compileDiagnostics,
      selectedNodeId,
      setSelectedNodeId,
      focusedNodeId,
      focusNode: (nodeId: string) => setFocusedNodeId(nodeId),
      requestRender: () => dispatch({ type: "render" }),
      attachPreviewCanvas: setCanvas,
      frameBudgetMs,
    }),
    [
      compileDiagnostics,
      focusedNodeId,
      frameBudgetMs,
      functions,
      previewState,
      selectedNodeId,
    ],
  );

  return (
    <MaterialEditingContext.Provider value={value}>
      {children}
    </MaterialEditingContext.Provider>
  );
}
