import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  normalizeBakeAuthoringSettings,
  type BakeAuthoringSettings,
  type SerializedScene,
} from "@babylonslate/core";
import { loadBakedLightingReference } from "@babylonslate/assets";
import type {
  PreparedSceneBake,
  SceneBakeOwner,
} from "@babylonslate/render/scene-bake-preparation";
import type { SceneBakeProgress } from "@babylonslate/render/scene-bake-job";
import { useDocuments } from "./document-context";
import { useDocumentWorkspace } from "./document-workspace-context";
import { SceneBakeDialog } from "../components/scene-bake-dialog";
import { waitPaintedFrame } from "../lib/nav-bake";

export type SceneBakeCollector = (
  scene: SerializedScene,
  owner: SceneBakeOwner,
) => {
  isCurrent(): boolean;
  prepare(
    settings: BakeAuthoringSettings,
    signal: AbortSignal,
  ): Promise<PreparedSceneBake>;
};
interface SceneBakeContextValue {
  registerCollector(collector: SceneBakeCollector | null): void;
  open(): void;
  ready: boolean;
  busy: boolean;
  status: "Unbuilt" | "Checking" | "Valid" | "Stale" | "Missing";
  detail: string | null;
}
const SceneBakeContext = createContext<SceneBakeContextValue | null>(null);

export function SceneBakeProvider({ children }: { children: ReactNode }) {
  const { documentId } = useDocumentWorkspace();
  const {
    openDocuments,
    assetRegistry,
    registryVersion,
    captureSceneBakeOwner,
    applySceneChange,
    projectDocument,
    refreshAssetRegistry,
  } = useDocuments();
  const document = openDocuments.find((entry) => entry.id === documentId);
  const scene =
    document?.ref.kind === "scene"
      ? (document.content as SerializedScene | null)
      : null;
  const [collector, setCollector] = useState<SceneBakeCollector | null>(null);
  const collectorRef = useRef<SceneBakeCollector | null>(null);
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<SceneBakeProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [status, setStatus] =
    useState<SceneBakeContextValue["status"]>("Unbuilt");
  const [detail, setDetail] = useState<string | null>(null);
  const [validationEpoch, setValidationEpoch] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const latest = useRef({ scene, captureSceneBakeOwner, assetRegistry });
  latest.current = { scene, captureSceneBakeOwner, assetRegistry };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abortRef.current?.abort();
    };
  }, []);
  const registerCollector = useCallback((next: SceneBakeCollector | null) => {
    collectorRef.current = next;
    setCollector(() => next);
  }, []);

  // This is source validation only: Save/settings/reopen never launches UV or transport work.
  useEffect(() => {
    if (busy || !scene || !assetRegistry) return;
    if (!scene.settings.bakedLightingAssetGuid) {
      setStatus("Unbuilt");
      setDetail(null);
      return;
    }
    if (!collector) {
      setStatus("Checking");
      return;
    }
    const abort = new AbortController();
    setStatus("Checking");
    void (async () => {
      try {
        const owner = captureSceneBakeOwner(documentId);
        const viewport = collector(owner.scene, owner);
        const prepared = await viewport.prepare(
          normalizeBakeAuthoringSettings(owner.scene.settings.bakeSettings),
          abort.signal,
        );
        if (abort.signal.aborted || !owner.isCurrent() || !viewport.isCurrent())
          return;
        const loaded = await loadBakedLightingReference({
          registry: assetRegistry,
          guid: scene.settings.bakedLightingAssetGuid,
          sceneGuid: owner.sceneGuid,
          inputs: prepared.inputs,
        });
        if (abort.signal.aborted || !owner.isCurrent() || !viewport.isCurrent())
          return;
        setStatus(
          loaded.validity.status === "valid"
            ? "Valid"
            : loaded.validity.status === "stale"
              ? "Stale"
              : "Missing",
        );
        setDetail(
          loaded.validity.status === "valid"
            ? "Saved bake matches these sources. Runtime application is not yet enabled."
            : loaded.validity.status === "missing"
              ? loaded.validity.reason
              : "Sources changed. Bake again to update the retained result.",
        );
      } catch (caught) {
        if (abort.signal.aborted) return;
        setStatus("Stale");
        setDetail(caught instanceof Error ? caught.message : String(caught));
      }
    })();
    return () => abort.abort();
  }, [
    scene,
    collector,
    busy,
    assetRegistry,
    registryVersion,
    captureSceneBakeOwner,
    documentId,
    projectDocument,
    validationEpoch,
  ]);

  const start = useCallback(async () => {
    if (abortRef.current) return;
    const abort = new AbortController();
    abortRef.current = abort;
    setBusy(true);
    setError(null);
    setMessage(null);
    setProgress({ phase: "preparing", progress: 0, receiver: 0, receivers: 0 });
    try {
      const owner = latest.current.captureSceneBakeOwner(documentId);
      const registry = latest.current.assetRegistry;
      const collect = collectorRef.current;
      if (!registry || !collect)
        throw new Error(
          "Wait for the Scene viewport to finish loading before baking.",
        );
      const viewport = collect(owner.scene, owner);
      const settings = normalizeBakeAuthoringSettings(
        owner.scene.settings.bakeSettings,
      );
      const current = () =>
        mounted.current && owner.isCurrent() && viewport.isCurrent();
      const { runSceneBakeJob } =
        await import("@babylonslate/render/scene-bake-job");
      abort.signal.throwIfAborted();
      await runSceneBakeJob({
        registry,
        rootId: owner.rootId,
        name: `${owner.scene.name} Lighting`,
        signal: abort.signal,
        isCurrent: current,
        commit: owner.commit,
        prepare: async (signal) => {
          await waitPaintedFrame();
          signal.throwIfAborted();
          if (!current())
            throw new Error("The Scene changed before baking started.");
          return viewport.prepare(settings, signal);
        },
        onProgress: (value) => {
          if (mounted.current) setProgress(value);
        },
      });
      if (mounted.current)
        setMessage(
          "Bake Saved. Realtime lighting remains active until runtime bake application is available.",
        );
      // Publication already succeeded. A catalog refresh must not report that
      // immutable result or the committed Scene reference as unsaved.
      try {
        await refreshAssetRegistry();
      } catch {
        if (mounted.current)
          setMessage(
            "Bake Saved. Reopen the project if generated assets are missing from the Content Browser.",
          );
      }
    } catch (caught) {
      if (mounted.current) {
        if (
          abort.signal.aborted &&
          !(
            abort.signal.reason instanceof Error &&
            abort.signal.reason.name !== "AbortError"
          )
        )
          setMessage("Bake Cancelled. The previous bake is retained.");
        else
          setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (abortRef.current === abort) abortRef.current = null;
      if (mounted.current) {
        setBusy(false);
        setValidationEpoch((value) => value + 1);
      }
    }
  }, [documentId, refreshAssetRegistry]);

  const ready = !!scene && scene.viewportMode === "3d" && !!collector;
  const value = useMemo(
    () => ({
      registerCollector,
      open: () => {
        setError(null);
        setMessage(null);
        setOpened(true);
      },
      ready,
      busy,
      status,
      detail,
    }),
    [registerCollector, ready, busy, status, detail],
  );
  return (
    <SceneBakeContext.Provider value={value}>
      {children}
      {opened && scene ? (
        <SceneBakeDialog
          busy={busy}
          progress={progress}
          error={error}
          message={message}
          settings={normalizeBakeAuthoringSettings(scene.settings.bakeSettings)}
          ready={ready}
          onSettings={(bakeSettings) => {
            void applySceneChange(documentId, {
              ...scene,
              settings: { ...scene.settings, bakeSettings },
            });
          }}
          onStart={() => {
            void start();
          }}
          onCancel={() => abortRef.current?.abort()}
          onClose={() => {
            if (!busy) setOpened(false);
          }}
        />
      ) : null}
    </SceneBakeContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- optional workspace context
export function useOptionalSceneBake() {
  return useContext(SceneBakeContext);
}
