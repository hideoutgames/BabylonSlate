import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_PLAY_FRAME_CAP,
  DEFAULT_PLAY_PREVIEW_PROJECT_SETTINGS,
  DEFAULT_RENDER_PROJECT_SETTINGS,
  type PlayPreviewProjectSettings,
  type RenderProjectSettings,
  type SerializedScene,
} from "@babylonslate/core";
import { cn } from "@babylonslate/ui/lib/utils";
import { SelectableText } from "@babylonslate/editor-kit";
import type { TracePayload } from "@babylonslate/debugger";
import { applyInspectSelectionToConsoleLine } from "@babylonslate/runtime";
import type { Engine } from "@babylonjs/core";
import {
  startPlaySession,
  type PlaySession,
  type PlaySessionResult,
} from "../services/play-session";
import type { StatsHudHighlight } from "./stats-hud";
import { attachLifecyclePause } from "../services/lifecycle-pause";
import {
  applyLiveEngineSettings,
  ENGINE_SETTINGS_CHANGED_EVENT,
  type LiveEngineSettings,
} from "../lib/viewport-render-gate";
import { createCanvasResizeGuard } from "../lib/canvas-resize-guard";
import { PrintOverlay, usePrintRegistry } from "./print-overlay";
import { DebugConsole } from "./debug-console";
import { DebugInspectDialog } from "./debug-inspect-dialog";
import { PlayOverlayChrome } from "./play-overlay-chrome";
import { StatsHud } from "./stats-hud";
import { TracePlayback } from "./trace-playback";
import { playConsoleCommands, playConsoleCompletionContext } from "../lib/play-console";
import { nextPlayInspectorOpen } from "../lib/play-debugger-defaults";
import type { ScriptBundleEntry, UiWidgetEventKind } from "@babylonslate/bridge";
import { applyPlayPreviewCanvasLayout, clampRenderResolution, playFramebufferSize } from "../lib/play-preview-aspect";
import type { PlayPhysicsSettings } from "../services/play-physics";
import type {
  SpriteAnimationPayload,
  SpritePayload,
  TilemapPayload,
  TilesetPayload,
} from "@babylonslate/assets";
import type { FontAssetEntry } from "@babylonslate/render";
import type { PlayAudioLibrary } from "../lib/play-audio";
import type { PlayParticleLibrary } from "../lib/play-particles";
import {
  PLAY_AUDIO_UNLOCK_HINT,
  shouldShowPlayAudioUnlockHint,
} from "../lib/play-audio-unlock-hint";
import type {
  MaterialDocument,
  MaterialFunctionDocument,
} from "@babylonslate/shader-graph";
import type { UserInterfaceDocument } from "@babylonslate/ui-runtime";
import { isTestModeEnabled } from "@babylonslate/vfs";
import { audioStats } from "@babylonslate/render";
import { useInspectWorldPoll } from "../lib/use-inspect-world-poll";
import { usePlay } from "../context/play-context";
import { PlayHudOverlay } from "./play-hud-overlay";
import {
  applyPlayHudInstance,
  applyPlayHudVisibility,
  playUserInterfaceRuntimeDocuments,
  removePlayHudInstance,
  resolvePlayHudDocuments,
  setPlayUiWidgetEventSink,
  type PlayHudInstance,
} from "../lib/play-content";

export interface PlayOverlayProps {
  sharedEngine: Engine;
  injectFixtureThrow?: boolean;
  scripts?: readonly ScriptBundleEntry[];
  physics?: PlayPhysicsSettings;
  sceneAssetGuid?: string;
  scene?: SerializedScene;
  gameInstanceClass?: string;
  scenes?: Array<{ guid: string; scene: SerializedScene }>;
  /** Project `playFrameCap` applied once when the session starts. */
  frameCap?: number;
  infiniteLoopDetection?: boolean;
  loopCount?: number;
  /** Project Play Preview letterbox; snapshotted when the session starts. */
  playPreview?: PlayPreviewProjectSettings;
  /** Project render size; snapshotted when the session starts. */
  render?: RenderProjectSettings;
  uiLibrary?: Record<string, UserInterfaceDocument>;
  fontEntries?: readonly FontAssetEntry[];
  resolveImageUrl?: (guid: string) => string | null;
  animGraphs?: ReadonlyArray<{ guid: string; document: unknown }>;
  behaviourTrees?: ReadonlyArray<{ guid: string; document: unknown }>;
  blackboards?: ReadonlyArray<{ guid: string; document: unknown }>;
  spritePayloads?: ReadonlyMap<string, SpritePayload>;
  spriteAnimationPayloads?: ReadonlyMap<string, SpriteAnimationPayload>;
  tilemapPayloads?: ReadonlyMap<string, TilemapPayload>;
  tilesetPayloads?: ReadonlyMap<string, TilesetPayload>;
  textureBytes?: ReadonlyMap<string, Uint8Array>;
  modelBytes?: ReadonlyMap<string, Uint8Array>;
  audioBytes?: ReadonlyMap<string, Uint8Array>;
  audioLibrary?: PlayAudioLibrary;
  particleLibrary?: PlayParticleLibrary;
  materialDocuments?: ReadonlyMap<string, MaterialDocument>;
  materialFunctions?: ReadonlyMap<string, MaterialFunctionDocument>;
  postProcessingEnabled?: boolean;
  hardwareScalingLevel?: number;
  pixelsPerUnit?: number;
  pixelPerfect?: boolean;
  navmeshBytes?: Uint8Array | null;
  audioReverbBytes?: Uint8Array | null;
  pauseOnPlay?: boolean;
  onClose: (result: PlaySessionResult) => void;
}

function emptyPlayResult(): PlaySessionResult {
  return {
    diagnostics: [],
    droppedDiagnostics: 0,
    textureCountBefore: 0,
    textureCountAfter: 0,
    textureLeak: false,
    runtimeMode: "in-process",
  };
}

export function PlayOverlay({
  sharedEngine,
  injectFixtureThrow,
  scripts,
  physics,
  sceneAssetGuid,
  scene,
  gameInstanceClass,
  scenes,
  frameCap = DEFAULT_PLAY_FRAME_CAP,
  infiniteLoopDetection,
  loopCount,
  playPreview = DEFAULT_PLAY_PREVIEW_PROJECT_SETTINGS,
  render = DEFAULT_RENDER_PROJECT_SETTINGS,
  uiLibrary = {},
  fontEntries = [],
  resolveImageUrl,
  animGraphs,
  behaviourTrees,
  blackboards,
  spritePayloads,
  spriteAnimationPayloads,
  tilemapPayloads,
  tilesetPayloads,
  textureBytes,
  modelBytes,
  audioBytes,
  audioLibrary,
  particleLibrary,
  materialDocuments,
  materialFunctions,
  postProcessingEnabled,
  hardwareScalingLevel,
  pixelsPerUnit,
  pixelPerfect,
  navmeshBytes,
  audioReverbBytes,
  pauseOnPlay = false,
  onClose,
}: PlayOverlayProps) {
  const { reportBtState, overlayStats, overlayConsole, overlayInspector } =
    usePlay();
  const overlayRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<PlaySession | null>(null);
  const [fps, setFps] = useState(0);
  const [scriptMs, setScriptMs] = useState(0);
  const [physicsMs, setPhysicsMs] = useState(0);
  const [memoryBytes, setMemoryBytes] = useState(0);
  const [meshCount, setMeshCount] = useState(0);
  const [textureCount, setTextureCount] = useState(0);
  const [draws, setDraws] = useState(0);
  const [bridgeRate, setBridgeRate] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [moveX, setMoveX] = useState<number | null>(null);
  const [actorGuids, setActorGuids] = useState<string[]>([]);
  const [actorYs, setActorYs] = useState<number[]>([]);
  const [audioQueued, setAudioQueued] = useState(0);
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [paused, setPaused] = useState(pauseOnPlay);
  const [statsOpen, setStatsOpen] = useState(false);
  const [statsHighlight, setStatsHighlight] = useState<StatsHudHighlight | null>(
    null,
  );
  const inspectSelectionRef = useRef<string | null>(null);
  const userPausedRef = useRef(pauseOnPlay);
  const [trace, setTrace] = useState<TracePayload | null>(null);
  const [overlaySize, setOverlaySize] = useState({ width: 1280, height: 720 });
  const [hiddenWidgetIds, setHiddenWidgetIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [hudInstances, setHudInstances] = useState<PlayHudInstance[]>([]);
  const [hudScene, setHudScene] = useState<import("@babylonjs/core").Scene | null>(
    null,
  );
  const [postProcessPasses, setPostProcessPasses] = useState(0);
  const [assignedMaterials, setAssignedMaterials] = useState("");
  const { entries: printEntries, print } = usePrintRegistry();
  const printRef = useRef(print);
  printRef.current = print;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closedRef = useRef(false);
  const finishSessionRef = useRef<() => void>(() => {});
  finishSessionRef.current = () => {
    if (closedRef.current) return;
    closedRef.current = true;
    const result = sessionRef.current?.stop() ?? emptyPlayResult();
    sessionRef.current = null;
    setHudScene(null);
    onCloseRef.current(result);
  };
  const scriptsRef = useRef(scripts);
  scriptsRef.current = scripts;
  const animGraphsRef = useRef(animGraphs);
  animGraphsRef.current = animGraphs;
  const behaviourTreesRef = useRef(behaviourTrees);
  behaviourTreesRef.current = behaviourTrees;
  const blackboardsRef = useRef(blackboards);
  blackboardsRef.current = blackboards;
  const spritePayloadsRef = useRef(spritePayloads);
  spritePayloadsRef.current = spritePayloads;
  const spriteAnimationPayloadsRef = useRef(spriteAnimationPayloads);
  spriteAnimationPayloadsRef.current = spriteAnimationPayloads;
  const tilemapPayloadsRef = useRef(tilemapPayloads);
  tilemapPayloadsRef.current = tilemapPayloads;
  const tilesetPayloadsRef = useRef(tilesetPayloads);
  tilesetPayloadsRef.current = tilesetPayloads;
  const textureBytesRef = useRef(textureBytes);
  textureBytesRef.current = textureBytes;
  const modelBytesRef = useRef(modelBytes);
  modelBytesRef.current = modelBytes;
  const audioBytesRef = useRef(audioBytes);
  audioBytesRef.current = audioBytes;
  const audioLibraryRef = useRef(audioLibrary);
  audioLibraryRef.current = audioLibrary;
  const particleLibraryRef = useRef(particleLibrary);
  particleLibraryRef.current = particleLibrary;
  const materialDocumentsRef = useRef(materialDocuments);
  materialDocumentsRef.current = materialDocuments;
  const materialFunctionsRef = useRef(materialFunctions);
  materialFunctionsRef.current = materialFunctions;
  const navmeshBytesRef = useRef(navmeshBytes);
  navmeshBytesRef.current = navmeshBytes;
  const audioReverbBytesRef = useRef(audioReverbBytes);
  audioReverbBytesRef.current = audioReverbBytes;
  const pixelsPerUnitRef = useRef(pixelsPerUnit);
  pixelsPerUnitRef.current = pixelsPerUnit;
  const pixelPerfectRef = useRef(pixelPerfect);
  pixelPerfectRef.current = pixelPerfect;
  const physicsRef = useRef(physics);
  physicsRef.current = physics;
  const sceneRef = useRef({
    sceneAssetGuid,
    scene,
    gameInstanceClass,
    scenes,
  });
  sceneRef.current = { sceneAssetGuid, scene, gameInstanceClass, scenes };
  const initialFrameCapRef = useRef(frameCap);
  const initialPauseOnPlayRef = useRef(pauseOnPlay);
  const initialInfiniteLoopDetectionRef = useRef(infiniteLoopDetection);
  const initialLoopCountRef = useRef(loopCount);
  const initialPlayPreviewRef = useRef(playPreview);
  const initialRenderRef = useRef(render);
  const liveSizeRef = useRef<{ width: number; height: number } | null>(null);
  const commands = useMemo(() => playConsoleCommands(scripts ?? []), [scripts]);
  const inspectSnapshot = useInspectWorldPoll(
    consoleOpen || nextPlayInspectorOpen(inspectorOpen, overlayInspector),
    () =>
      sessionRef.current?.inspectWorld() ??
      Promise.resolve({ tickIndex: 0, nodes: [] }),
  );
  const completionContext = useMemo(
    () =>
      playConsoleCompletionContext({
        commands,
        sceneAssetGuid,
        scene,
        scenes,
        inspectNodes: inspectSnapshot.nodes,
      }),
    [commands, sceneAssetGuid, scene, scenes, inspectSnapshot],
  );

  useEffect(() => {
    setInspectorOpen((open) => nextPlayInspectorOpen(open, overlayInspector));
  }, [overlayInspector]);

  useEffect(() => {
    const overlay = overlayRef.current;
    const canvas = canvasRef.current;
    if (!overlay || !canvas) return;
    const layoutPlay = () => {
      applyPlayPreviewCanvasLayout({
        overlay,
        canvas,
        ...initialPlayPreviewRef.current,
        render: initialRenderRef.current,
        liveSize: liveSizeRef.current,
      });
      setOverlaySize({
        width: overlay.clientWidth || 1280,
        height: overlay.clientHeight || 720,
      });
    };
    const resizeIfSized = createCanvasResizeGuard(() => {
      sessionRef.current?.handle.resize();
    });
    const syncFramebuffer = (sessionHandle: { setSize: (w: number, h: number) => void; resize: () => void }) => {
      const framebuffer = playFramebufferSize(
        initialRenderRef.current,
        liveSizeRef.current,
      );
      if (framebuffer) {
        sessionHandle.setSize(framebuffer.width, framebuffer.height);
        return;
      }
      resizeIfSized(canvas);
    };
    layoutPlay();
    userPausedRef.current = initialPauseOnPlayRef.current;
    setPaused(initialPauseOnPlayRef.current);
    const session = startPlaySession({
      canvas,
      sharedEngine,
      injectFixtureThrow,
      scripts: scriptsRef.current,
      physics: physicsRef.current,
      sceneAssetGuid: sceneRef.current.sceneAssetGuid,
      scene: sceneRef.current.scene,
      gameInstanceClass: sceneRef.current.gameInstanceClass,
      scenes: sceneRef.current.scenes,
      frameCap: initialFrameCapRef.current,
      infiniteLoopDetection: initialInfiniteLoopDetectionRef.current,
      loopCount: initialLoopCountRef.current,
      animGraphs: animGraphsRef.current,
      behaviourTrees: behaviourTreesRef.current,
      blackboards: blackboardsRef.current,
      spritePayloads: spritePayloadsRef.current,
      spriteAnimationPayloads: spriteAnimationPayloadsRef.current,
      tilemapPayloads: tilemapPayloadsRef.current,
      tilesetPayloads: tilesetPayloadsRef.current,
      textureBytes: textureBytesRef.current,
      modelBytes: modelBytesRef.current,
      audioBytes: audioBytesRef.current,
      audioLibrary: audioLibraryRef.current,
      particleLibrary: particleLibraryRef.current,
      materialDocuments: materialDocumentsRef.current,
      materialFunctions: materialFunctionsRef.current,
      postProcessingEnabled,
      hardwareScalingLevel,
      pixelsPerUnit: pixelsPerUnitRef.current,
      pixelPerfect: pixelPerfectRef.current,
      navmeshBytes: navmeshBytesRef.current,
      audioReverbBytes: audioReverbBytesRef.current,
      pauseOnPlay: initialPauseOnPlayRef.current,
      onSessionPaused: (next) => {
        userPausedRef.current = next;
        setPaused(next);
      },
      onShowFps: (enabled) => {
        setStatsOpen(enabled);
        if (!enabled) setStatsHighlight(null);
      },
      onStatHighlight: (name, enabled) => {
        setStatsOpen(true);
        setStatsHighlight(
          enabled &&
            (name === "unit" ||
              name === "memory" ||
              name === "draws" ||
              name === "threads")
            ? name
            : null,
        );
      },
      userInterfaces: playUserInterfaceRuntimeDocuments(uiLibrary),
      onUiSetVisible: (instanceId, widgetId, visible) => {
        setHiddenWidgetIds((prev) =>
          applyPlayHudVisibility(prev, instanceId, widgetId, visible),
        );
      },
      onUiApply: (instanceId, classId, assetGuid) => {
        setHudInstances((prev) =>
          applyPlayHudInstance(prev, instanceId, assetGuid, classId),
        );
      },
      onUiRemove: (instanceId) => {
        setHudInstances((prev) => removePlayHudInstance(prev, instanceId));
      },
      onStats: (stats) => {
        setFps(stats.fps);
        setScriptMs(stats.scriptMs);
        setPhysicsMs(stats.physicsMs);
        setMoveX(sessionRef.current?.lastMoveX() ?? null);
      },
      onLog: (message) =>
        setLogs((prev) => [...prev.slice(-200), message]),
      onPrint: (entry) => printRef.current(entry),
      onBtState: (state) => reportBtState(state),
      onSetRenderResolution: (width, height) => {
        liveSizeRef.current = {
          width: clampRenderResolution(width),
          height: clampRenderResolution(height),
        };
        layoutPlay();
        const current = sessionRef.current;
        if (current) syncFramebuffer(current.handle);
      },
      onFatalDiagnostic: () => finishSessionRef.current(),
    });
    sessionRef.current = session;
    if (initialPauseOnPlayRef.current) {
      session.setPaused(true);
    }
    setPlayUiWidgetEventSink((event) =>
      sessionRef.current?.dispatchUiWidgetEvent(event) ?? false,
    );
    if (isTestModeEnabled()) {
      const host = globalThis as {
        __babylonslateTest?: {
          dispatchPlayUiWidgetEvent?: (
            event: {
              instanceId: string;
              widgetId: string;
              kind: UiWidgetEventKind;
              value?: unknown;
            },
          ) => boolean;
        };
      };
      if (host.__babylonslateTest) {
        host.__babylonslateTest.dispatchPlayUiWidgetEvent = (event) =>
          sessionRef.current?.dispatchUiWidgetEvent(event) ?? false;
      }
    }
    setHudScene(session.handle.scene);
    syncFramebuffer(session.handle);
    const resizeObserver = new ResizeObserver(() => {
      layoutPlay();
      const framebuffer = playFramebufferSize(
        initialRenderRef.current,
        liveSizeRef.current,
      );
      if (!framebuffer) {
        syncFramebuffer(session.handle);
      }
    });
    resizeObserver.observe(overlay);
    const detachLifecycle = attachLifecyclePause((hidden) => {
      sessionRef.current?.setPaused(hidden || userPausedRef.current);
    });
    const movePoll = window.setInterval(() => {
      const current = sessionRef.current;
      setMoveX(current?.lastMoveX() ?? null);
      setActorGuids([...(current?.spawnedActorGuids() ?? [])]);
      setActorYs((current?.lastActorPositions() ?? []).map((entry) => entry.y));
      setAudioQueued(audioStats.queued);
      setAudioUnlocked(audioStats.unlocked);
      if (current) {
        setMemoryBytes(current.accountedBytes());
        const counts = current.liveObjectCounts();
        setMeshCount(counts.meshes);
        setTextureCount(counts.textures);
        setDraws(current.drawCalls());
        setBridgeRate(current.bridgeMessagesPerSec());
        setPostProcessPasses(current.handle.postProcessPassCount());
        setAssignedMaterials(current.handle.assignedMaterialGuids().join(","));
        const recorded = current.lastTrace();
        if (recorded) setTrace(recorded);
      }
    }, 200);
    const onSettings = (event: Event) => {
      const detail = (event as CustomEvent<LiveEngineSettings>).detail;
      if (!detail) return;
      applyLiveEngineSettings(session.handle, detail, { applyFrameCap: false });
      setPostProcessPasses(session.handle.postProcessPassCount());
    };
    window.addEventListener(ENGINE_SETTINGS_CHANGED_EVENT, onSettings);
    return () => {
      window.removeEventListener(ENGINE_SETTINGS_CHANGED_EVENT, onSettings);
      resizeObserver.disconnect();
      window.clearInterval(movePoll);
      detachLifecycle();
      reportBtState(null);
      setPlayUiWidgetEventSink(null);
      if (sessionRef.current) {
        sessionRef.current.stop();
        sessionRef.current = null;
      }
      setHudScene(null);
    };
  }, [sharedEngine, injectFixtureThrow, reportBtState]);

  useEffect(() => {
    if (!isTestModeEnabled()) return;
    const host = globalThis as {
      __babylonslatePlayTest?: {
        actorPositions: () => readonly {
          slotId: number;
          x: number;
          y: number;
          z: number;
        }[];
        visuals: () => ReturnType<PlaySession["handle"]["playVisualStates"]>;
        liveObjectCounts: () => { meshes: number; textures: number } | null;
      };
    };
    host.__babylonslatePlayTest = {
      actorPositions: () => sessionRef.current?.lastActorPositions() ?? [],
      visuals: () => sessionRef.current?.handle.playVisualStates() ?? [],
      liveObjectCounts: () => sessionRef.current?.liveObjectCounts() ?? null,
    };
    return () => {
      delete host.__babylonslatePlayTest;
    };
  }, []);

  return (
    <div
      ref={overlayRef}
      className={cn(
        "fixed inset-0 z-50 flex flex-col",
        playPreview.followSystem
          ? "bg-background"
          : "items-center justify-center bg-black",
      )}
      data-testid="play-overlay"
      data-post-process-passes={String(postProcessPasses)}
      data-assigned-materials={assignedMaterials}
    >
      <PlayOverlayChrome
        paused={paused}
        statsOpen={statsOpen}
        inspectorOpen={inspectorOpen}
        showStats={overlayStats}
        showConsole={overlayConsole}
        showInspector={overlayInspector}
        onPauseToggle={() => {
          setPaused((prev) => {
            const next = !prev;
            userPausedRef.current = next;
            sessionRef.current?.setPaused(next);
            return next;
          });
        }}
        onStatsToggle={() => setStatsOpen((open) => !open)}
        onConsoleOpen={() => setConsoleOpen(true)}
        onInspectorToggle={() => setInspectorOpen((open) => !open)}
        onStep={() => sessionRef.current?.step()}
        onClose={() => finishSessionRef.current()}
        stats={
          <StatsHud
            fps={fps}
            scriptMs={scriptMs}
            physicsMs={physicsMs}
            memoryBytes={memoryBytes}
            meshCount={meshCount}
            textureCount={textureCount}
            draws={draws}
            bridgeMessagesPerSec={bridgeRate}
            highlight={statsHighlight}
          />
        }
        extras={
          <>
            <span
              data-testid="play-move-x"
              data-move-x={moveX === null ? "" : String(moveX)}
              className="sr-only"
            >
              <SelectableText>
                move.x={moveX === null ? "—" : moveX.toFixed(2)}
              </SelectableText>
            </span>
            <span
              data-testid="play-actor-guids"
              data-guids={actorGuids.join(",")}
            />
            <span
              data-testid="play-actor-y"
              data-ys={actorYs.join(",")}
            />
            {shouldShowPlayAudioUnlockHint({
              queued: audioQueued,
              unlocked: audioUnlocked,
            }) ? (
              <p
                data-testid="play-audio-unlock-hint"
                className="text-sm text-muted-foreground"
              >
                <SelectableText>{PLAY_AUDIO_UNLOCK_HINT}</SelectableText>
              </p>
            ) : null}
          </>
        }
      />
      <canvas
        ref={canvasRef}
        className={cn(
          "touch-none",
          playPreview.followSystem && "h-full w-full",
        )}
        data-testid="play-canvas"
      />
      <PlayHudOverlay
        instances={resolvePlayHudDocuments(hudInstances, uiLibrary)}
        uiLibrary={uiLibrary}
        fontEntries={fontEntries}
        resolveImageUrl={resolveImageUrl}
        width={overlaySize.width}
        height={overlaySize.height}
        hiddenWidgetIds={hiddenWidgetIds}
        scene={hudScene}
        onTouchAxis={(controlId, value) =>
          sessionRef.current?.pushTouchAxis(controlId, value)
        }
        onWidgetEvent={(event) =>
          sessionRef.current?.dispatchUiWidgetEvent(event)
        }
      />
      <PrintOverlay entries={printEntries} />
      {logs.length > 0 ? (
        <div
          className="pointer-events-none absolute bottom-3 left-3 max-h-32 max-w-md overflow-hidden rounded-md bg-background/80 p-2 text-xs"
          data-testid="play-log-tail"
        >
          {logs.slice(-5).map((line, i) => (
            <div key={`${i}-${line}`}>
              <SelectableText>{line}</SelectableText>
            </div>
          ))}
        </div>
      ) : null}
      <DebugConsole
        open={consoleOpen}
        onOpenChange={setConsoleOpen}
        commands={commands}
        completionContext={completionContext}
        onExecute={(line) =>
          sessionRef.current?.executeConsoleCommand(
            applyInspectSelectionToConsoleLine(
              line,
              inspectSelectionRef.current,
            ),
          ) ?? Promise.resolve({ success: false, output: "not playing" })
        }
      />
      <DebugInspectDialog
        open={nextPlayInspectorOpen(inspectorOpen, overlayInspector)}
        onOpenChange={setInspectorOpen}
        snapshot={inspectSnapshot}
        onSelectedIdChange={(id) => {
          inspectSelectionRef.current = id;
        }}
      />
      {trace ? (
        <div
          className="absolute bottom-3 right-3 z-10 max-h-64 w-80 overflow-auto rounded-md border border-border bg-background/95"
          data-testid="play-trace-playback"
        >
          <TracePlayback payload={trace} />
        </div>
      ) : null}
    </div>
  );
}
