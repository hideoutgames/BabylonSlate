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
import type { Engine } from "@babylonjs/core";
import {
  DEFAULT_PLAY_FRAME_CAP,
  DEFAULT_PLAY_PREVIEW_PROJECT_SETTINGS,
} from "@babylonslate/core";
import { createAppEngine } from "@babylonslate/render";
import type { SessionReportEntry } from "@babylonslate/runtime";
import type { ScriptBundleEntry } from "@babylonslate/bridge";
import type { Diagnostic } from "@babylonslate/scripting";
import { PlayOverlay } from "../components/play-overlay";
import { PlayPrepareDialog } from "../components/play-prepare-dialog";
import { PlayBlockedDialog } from "../components/play-blocked-dialog";
import { useDocuments } from "./document-context";
import { useValidation } from "./validation-context";
import { PreviewSessionReport } from "../components/preview-session-report";
import type { PlaySessionResult } from "../services/play-session";
import { PREVIEW_FIXTURE_NODE_ID } from "../services/play-session";
import {
  playPhysicsFromOpenDocuments,
  playPhysicsFromSceneSettings,
  resolvePlayScene,
  type PlaySceneLoad,
} from "../services/play-physics";
import type { PlayAnimGraphEntry } from "../lib/play-content";
import type { SpritePayload, TilemapPayload, TilesetPayload } from "@babylonslate/assets";
import { attachLifecyclePause } from "../services/lifecycle-pause";
import { setEncodeQueuePauseReason } from "../services/encode-queue-pause";
import {
  EditorSchedulerRegistry,
  type EditorLoopHandle,
} from "../lib/editor-scheduler-registry";
import { planPlayPreviewPrepare } from "../services/play-preview-prepare";
import { projectHasBlockingErrors } from "../services/graph-validation";
import type { PlayPreparePhase } from "../components/play-prepare-dialog";
import type { UserInterfaceDocument } from "@babylonslate/ui-runtime";

type PlayOptions = { injectFixtureThrow?: boolean };

interface PlayContextValue {
  playing: boolean;
  preparing: boolean;
  playAwaitingMigration: boolean;
  requestPlay: (options?: PlayOptions) => Promise<void>;
  launchPlay: (options?: PlayOptions & { scripts?: ScriptBundleEntry[] }) => void;
  resumePlayAfterMigration: () => Promise<void>;
  cancelPlayMigration: () => void;
  stopPlay: () => void;
  registerSharedEngine: (engine: Engine | null) => void;
  ensureSharedEngine: () => Engine | null;
  registerScheduler: (scheduler: EditorLoopHandle) => () => void;
  focusedNodeId: string | null;
  clearFocusedNode: () => void;
  appendLog: (line: string) => void;
  logLines: string[];
  alwaysRender: boolean;
  setAlwaysRender: (value: boolean) => void;
  renderStats: { renderedFps: number; invalidationsPerSecond: number } | null;
}

const PlayContext = createContext<PlayContextValue | null>(null);
const OutputLogContext = createContext<{ lines: string[] }>({ lines: [] });

export function PlayProvider({ children }: { children: ReactNode }) {
  const engineRef = useRef<Engine | null>(null);
  const ownedEngineRef = useRef<Engine | null>(null);
  const ownedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const schedulerRegistryRef = useRef(new EditorSchedulerRegistry());
  const preparingRef = useRef(false);
  const pendingPlayOptionsRef = useRef<PlayOptions | undefined>(undefined);
  const pendingScriptsRef = useRef<ScriptBundleEntry[] | null>(null);
  const [playing, setPlaying] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [playAwaitingMigration, setPlayAwaitingMigration] = useState(false);
  const [prepareState, setPrepareState] = useState<{
    phase: PlayPreparePhase;
    dirtyNames: string[];
  } | null>(null);
  const [playBlockedOpen, setPlayBlockedOpen] = useState(false);
  const [blockedDiagnostics, setBlockedDiagnostics] = useState<Diagnostic[]>([]);
  const [injectThrow, setInjectThrow] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportEntries, setReportEntries] = useState<SessionReportEntry[]>([]);
  const [dropped, setDropped] = useState(0);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [alwaysRender, setAlwaysRenderState] = useState(true);
  const [renderStats, setRenderStats] = useState<{
    renderedFps: number;
    invalidationsPerSecond: number;
  } | null>(null);
  const [lastRuntimeMode, setLastRuntimeMode] = useState<
    "worker" | "in-process" | null
  >(null);
  const [scripts, setScripts] = useState<ScriptBundleEntry[]>([]);
  const [playUiLibrary, setPlayUiLibrary] = useState<
    Record<string, UserInterfaceDocument>
  >({});
  const [playAnimGraphs, setPlayAnimGraphs] = useState<PlayAnimGraphEntry[]>(
    [],
  );
  const [playSpritePayloads, setPlaySpritePayloads] = useState<
    Map<string, SpritePayload>
  >(() => new Map());
  const [playTilemaps, setPlayTilemaps] = useState<Map<string, TilemapPayload>>(
    () => new Map(),
  );
  const [playTilesets, setPlayTilesets] = useState<Map<string, TilesetPayload>>(
    () => new Map(),
  );
  const [playTextureBytes, setPlayTextureBytes] = useState<
    Map<string, Uint8Array>
  >(() => new Map());
  const [playModelBytes, setPlayModelBytes] = useState<Map<string, Uint8Array>>(
    () => new Map(),
  );
  const [playSceneLoad, setPlaySceneLoad] = useState<PlaySceneLoad | null>(null);
  const [playSceneLibrary, setPlaySceneLibrary] = useState<
    Array<{ guid: string; scene: import("@babylonslate/core").SerializedScene }>
  >([]);
  const {
    collectPlayPreviewScripts,
    collectPlayUiLibrary,
    collectPlayAnimGraphs,
    collectPlaySpritePayloads,
    collectPlayTilemapContent,
    collectPlayTextureBytes,
    collectPlayModelBytes,
    collectPlayStartupScene,
    collectPlaySceneLibrary,
    openDocuments,
    activeDocumentId,
    projectDocument,
    dirtyDocuments,
    scriptsStale,
    migrationPending,
    saveAll,
  } = useDocuments();
  const { diagnostics, setDiagnostics, setFocusDiagnostic } = useValidation();
  const playScene = resolvePlayScene({
    documents: openDocuments,
    activeDocumentId,
    fallback: playSceneLoad,
  });
  const playPhysics = playScene
    ? playPhysicsFromSceneSettings(playScene.scene.settings)
    : playPhysicsFromOpenDocuments(openDocuments, activeDocumentId);

  const appendLog = useCallback((line: string) => {
    setLogLines((prev) => [...prev.slice(-500), line]);
  }, []);

  const registerSharedEngine = useCallback((engine: Engine | null) => {
    // Prefer viewport-owned engine; keep fallback owned engine if viewport gone.
    if (engine) {
      engineRef.current = engine;
      return;
    }
    engineRef.current = ownedEngineRef.current;
  }, []);

  const registerScheduler = useCallback((scheduler: EditorLoopHandle) => {
    return schedulerRegistryRef.current.register(scheduler);
  }, []);

  const setAlwaysRender = useCallback((value: boolean) => {
    setAlwaysRenderState(value);
    schedulerRegistryRef.current.setAlwaysRender(value);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      const stats = schedulerRegistryRef.current.stats();
      if (stats) setRenderStats(stats);
    }, 500);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    return attachLifecyclePause((paused) => {
      schedulerRegistryRef.current.setPaused(paused);
      setEncodeQueuePauseReason("visibility", paused);
    });
  }, []);

  useEffect(() => {
    if (projectDocument) return;
    setScripts([]);
    setPlaying(false);
    setPrepareState(null);
    setPlayBlockedOpen(false);
    setBlockedDiagnostics([]);
    setPlayAwaitingMigration(false);
    pendingScriptsRef.current = null;
    pendingPlayOptionsRef.current = undefined;
  }, [projectDocument]);

  const ensureEngine = useCallback((): Engine | null => {
    if (engineRef.current) return engineRef.current;
    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 8;
    canvas.style.display = "none";
    document.body.appendChild(canvas);
    const engine = createAppEngine(canvas);
    ownedCanvasRef.current = canvas;
    ownedEngineRef.current = engine;
    engineRef.current = engine;
    return engine;
  }, []);

  const launchPlay = useCallback(
    (options?: PlayOptions & { scripts?: ScriptBundleEntry[] }) => {
      if (!ensureEngine()) {
        appendLog("Play failed: could not create Engine.");
        return;
      }
      setEncodeQueuePauseReason("play", true);
      setInjectThrow(Boolean(options?.injectFixtureThrow));
      if (options?.scripts) {
        setScripts(options.scripts);
      }
      setPlaying(true);
    },
    [appendLog, ensureEngine],
  );

  const requestPlay = useCallback(
    async (options?: PlayOptions) => {
      if (playing || preparingRef.current) return;
      pendingPlayOptionsRef.current = options;
      const inject = Boolean(options?.injectFixtureThrow);
      const plan = planPlayPreviewPrepare({
        dirtyDocuments: dirtyDocuments.map((doc) => ({ label: doc.ref.label })),
        scriptsStale,
        migrationPending: migrationPending.length > 0,
      });

      if (plan.action === "migrate") {
        setPlayAwaitingMigration(true);
        return;
      }

      preparingRef.current = true;
      setPreparing(true);
      try {
        if (plan.action === "prepare") {
          setPrepareState({
            phase: plan.needsSave ? "saving" : "compiling",
            dirtyNames: plan.dirtyNames,
          });
          if (plan.needsSave) {
            const saved = await saveAll();
            if (!saved) {
              setPrepareState(null);
              setPlayAwaitingMigration(true);
              return;
            }
          }
          setPrepareState({
            phase: "compiling",
            dirtyNames: plan.dirtyNames,
          });
        }

        const shouldCompile =
          scriptsStale ||
          scripts.length === 0 ||
          (plan.action === "prepare" && plan.needsCompile);
        let nextScripts = scripts;
        let nextDiagnostics = diagnostics;
        if (shouldCompile) {
          const result = await collectPlayPreviewScripts();
          nextScripts = result.bundles;
          nextDiagnostics = result.diagnostics;
          setScripts(nextScripts);
          setDiagnostics(nextDiagnostics);
        }
        const fallbackScene = await collectPlayStartupScene();
        const resolvedScene = resolvePlayScene({
          documents: openDocuments,
          activeDocumentId,
          fallback: fallbackScene,
        });
        setPlaySceneLoad(resolvedScene);
        try {
          setPlaySceneLibrary(await collectPlaySceneLibrary());
        } catch (error) {
          appendLog(
            `Scene library failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          setPlaySceneLibrary([]);
        }
        try {
          setPlayUiLibrary(await collectPlayUiLibrary());
        } catch (error) {
          appendLog(
            `UserInterface library failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          setPlayUiLibrary({});
        }
        try {
          setPlayAnimGraphs(await collectPlayAnimGraphs(resolvedScene?.scene));
        } catch (error) {
          appendLog(
            `AnimationGraph load failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          setPlayAnimGraphs([]);
        }
        let sprites = new Map<string, SpritePayload>();
        let tilesets = new Map<string, TilesetPayload>();
        try {
          sprites = await collectPlaySpritePayloads(resolvedScene?.scene);
          setPlaySpritePayloads(sprites);
        } catch (error) {
          appendLog(
            `Sprite payload load failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          setPlaySpritePayloads(new Map());
        }
        try {
          const tileContent = await collectPlayTilemapContent(resolvedScene?.scene);
          setPlayTilemaps(tileContent.tilemaps);
          setPlayTilesets(tileContent.tilesets);
          tilesets = tileContent.tilesets;
        } catch (error) {
          appendLog(
            `Tilemap load failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          setPlayTilemaps(new Map());
          setPlayTilesets(new Map());
        }
        try {
          setPlayTextureBytes(await collectPlayTextureBytes(sprites, tilesets));
        } catch (error) {
          appendLog(
            `Texture load failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          setPlayTextureBytes(new Map());
        }
        try {
          setPlayModelBytes(await collectPlayModelBytes(resolvedScene?.scene));
        } catch (error) {
          appendLog(
            `Model load failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          setPlayModelBytes(new Map());
        }

        setPrepareState(null);

        if (!inject && projectHasBlockingErrors(nextDiagnostics)) {
          pendingScriptsRef.current = nextScripts;
          setBlockedDiagnostics(nextDiagnostics);
          setPlayBlockedOpen(true);
          return;
        }

        launchPlay({ injectFixtureThrow: inject, scripts: nextScripts });
      } catch (error) {
        appendLog(
          `Script compile failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        setPrepareState(null);
        setScripts([]);
        if (inject) {
          launchPlay({ injectFixtureThrow: true, scripts: [] });
        }
      } finally {
        preparingRef.current = false;
        setPreparing(false);
      }
    },
    [
      appendLog,
      collectPlayPreviewScripts,
      collectPlayUiLibrary,
      collectPlayAnimGraphs,
      collectPlaySpritePayloads,
      collectPlayTilemapContent,
      collectPlayTextureBytes,
      collectPlayModelBytes,
      collectPlayStartupScene,
      collectPlaySceneLibrary,
      diagnostics,
      dirtyDocuments,
      launchPlay,
      migrationPending.length,
      playing,
      playScene,
      openDocuments,
      activeDocumentId,
      saveAll,
      scripts,
      scriptsStale,
      setDiagnostics,
    ],
  );

  const resumePlayAfterMigration = useCallback(async () => {
    setPlayAwaitingMigration(false);
    await requestPlay(pendingPlayOptionsRef.current);
  }, [requestPlay]);

  const cancelPlayMigration = useCallback(() => {
    setPlayAwaitingMigration(false);
    pendingPlayOptionsRef.current = undefined;
  }, []);

  const handleClose = useCallback(
    (result: PlaySessionResult) => {
      setPlaying(false);
      setEncodeQueuePauseReason("play", false);
      setDropped(result.droppedDiagnostics);
      setReportEntries(result.diagnostics);
      setLastRuntimeMode(result.runtimeMode);
      if (result.diagnostics.length > 0) {
        setReportOpen(true);
      }
      const leakNote = result.textureLeak ? " LEAK" : "";
      appendLog(
        `Play ended (${result.runtimeMode}; textures ${result.textureCountBefore}→${result.textureCountAfter}${leakNote})`,
      );
      if (result.textureLeak) {
        appendLog(
          `Texture leak detected: ${result.textureCountBefore} → ${result.textureCountAfter}`,
        );
      }
    },
    [appendLog],
  );

  const value = useMemo<PlayContextValue>(
    () => ({
      playing,
      preparing,
      playAwaitingMigration,
      requestPlay,
      launchPlay,
      resumePlayAfterMigration,
      cancelPlayMigration,
      stopPlay: () => setPlaying(false),
      registerSharedEngine,
      ensureSharedEngine: ensureEngine,
      registerScheduler,
      focusedNodeId,
      clearFocusedNode: () => setFocusedNodeId(null),
      appendLog,
      logLines,
      alwaysRender,
      setAlwaysRender,
      renderStats,
    }),
    [
      playing,
      preparing,
      playAwaitingMigration,
      requestPlay,
      launchPlay,
      resumePlayAfterMigration,
      cancelPlayMigration,
      registerSharedEngine,
      ensureEngine,
      registerScheduler,
      focusedNodeId,
      appendLog,
      logLines,
      alwaysRender,
      setAlwaysRender,
      renderStats,
    ],
  );

  return (
    <PlayContext.Provider value={value}>
      <OutputLogContext.Provider value={{ lines: logLines }}>
        {children}
        {prepareState ? (
          <PlayPrepareDialog
            open
            phase={prepareState.phase}
            dirtyNames={prepareState.dirtyNames}
          />
        ) : null}
        <PlayBlockedDialog
          open={playBlockedOpen}
          diagnostics={blockedDiagnostics}
          onOpenChange={setPlayBlockedOpen}
          onNavigate={(d) => {
            setFocusDiagnostic(d);
            setPlayBlockedOpen(false);
          }}
          onPlayAnyway={() => {
            setPlayBlockedOpen(false);
            launchPlay({
              injectFixtureThrow: pendingPlayOptionsRef.current?.injectFixtureThrow,
              scripts: pendingScriptsRef.current ?? scripts,
            });
          }}
        />
        {playing && engineRef.current ? (
          <PlayOverlay
            sharedEngine={engineRef.current}
            injectFixtureThrow={injectThrow}
            scripts={scripts}
            physics={playPhysics}
            sceneAssetGuid={playScene?.sceneAssetGuid}
            scene={playScene?.scene}
            gameInstanceClass={playScene?.scene.settings.gameInstanceClass ?? undefined}
            scenes={playSceneLibrary}
            uiLibrary={playUiLibrary}
            animGraphs={playAnimGraphs}
            spritePayloads={playSpritePayloads}
            tilemapPayloads={playTilemaps}
            tilesetPayloads={playTilesets}
            textureBytes={playTextureBytes}
            modelBytes={playModelBytes}
            pixelsPerUnit={
              projectDocument?.settings.twoD.pixelsPerUnit ?? 100
            }
            frameCap={
              projectDocument?.settings.playFrameCap ?? DEFAULT_PLAY_FRAME_CAP
            }
            playPreview={
              projectDocument?.settings.playPreview ??
              DEFAULT_PLAY_PREVIEW_PROJECT_SETTINGS
            }
            onClose={handleClose}
          />
        ) : null}
        <PreviewSessionReport
          open={reportOpen}
          entries={reportEntries}
          dropped={dropped}
          onOpenChange={setReportOpen}
          onNavigate={(entry) => {
            setFocusedNodeId(entry.nodeId ?? PREVIEW_FIXTURE_NODE_ID);
            setReportOpen(false);
            appendLog(
              `Navigate to node ${entry.nodeId ?? PREVIEW_FIXTURE_NODE_ID}`,
            );
          }}
        />
        {/* Focus marker for Playwright / graph navigation hook. */}
        {focusedNodeId ? (
          <span
            className="sr-only"
            data-testid="focused-graph-node"
            data-node-id={focusedNodeId}
          >
            {focusedNodeId}
          </span>
        ) : null}
        {lastRuntimeMode ? (
          <span
            className="sr-only"
            data-testid="play-last-runtime"
            data-mode={lastRuntimeMode}
          >
            {lastRuntimeMode}
          </span>
        ) : null}
      </OutputLogContext.Provider>
    </PlayContext.Provider>
  );
}

export function usePlay(): PlayContextValue {
  const ctx = useContext(PlayContext);
  if (!ctx) {
    throw new Error("usePlay requires PlayProvider");
  }
  return ctx;
}

export function useOptionalPlay(): PlayContextValue | null {
  return useContext(PlayContext);
}

export function useOutputLog(): { lines: string[] } {
  return useContext(OutputLogContext);
}
