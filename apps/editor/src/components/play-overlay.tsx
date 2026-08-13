import { useEffect, useMemo, useRef, useState } from "react";
import { TerminalIcon, XIcon } from "lucide-react";
import {
  DEFAULT_PLAY_FRAME_CAP,
  DEFAULT_PLAY_PREVIEW_PROJECT_SETTINGS,
  type PlayPreviewProjectSettings,
  type SerializedScene,
} from "@babylonslate/core";
import { Button } from "@babylonslate/ui/components/button";
import { cn } from "@babylonslate/ui/lib/utils";
import { SelectableText } from "@babylonslate/editor-kit";
import type { TracePayload } from "@babylonslate/debugger";
import type { Engine } from "@babylonjs/core";
import {
  startPlaySession,
  type PlaySession,
  type PlaySessionResult,
} from "../services/play-session";
import { attachLifecyclePause } from "../services/lifecycle-pause";
import { PrintOverlay, usePrintRegistry } from "./print-overlay";
import { DebugConsole } from "./debug-console";
import { StatsHud } from "./stats-hud";
import { TracePlayback } from "./trace-playback";
import { playConsoleCommands } from "../lib/play-console";
import type { ScriptBundleEntry } from "@babylonslate/bridge";
import { applyPlayPreviewCanvasLayout } from "../lib/play-preview-aspect";
import type { PlayPhysicsSettings } from "../services/play-physics";
import type { SpritePayload } from "@babylonslate/assets";
import type { UserInterfaceDocument } from "@babylonslate/ui-runtime";
import { PlayHudOverlay } from "./play-hud-overlay";
import {
  applyPlayHudInstance,
  removePlayHudInstance,
  resolvePlayHudDocuments,
  type PlayHudInstance,
} from "../lib/play-content";

export interface PlayOverlayProps {
  sharedEngine: Engine;
  injectFixtureThrow?: boolean;
  scripts?: readonly ScriptBundleEntry[];
  physics?: PlayPhysicsSettings;
  sceneAssetGuid?: string;
  scene?: SerializedScene;
  /** Project `playFrameCap` applied once when the session starts. */
  frameCap?: number;
  /** Project Play Preview letterbox; snapshotted when the session starts. */
  playPreview?: PlayPreviewProjectSettings;
  uiLibrary?: Record<string, UserInterfaceDocument>;
  animGraphs?: ReadonlyArray<{ guid: string; document: unknown }>;
  spritePayloads?: ReadonlyMap<string, SpritePayload>;
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
  frameCap = DEFAULT_PLAY_FRAME_CAP,
  playPreview = DEFAULT_PLAY_PREVIEW_PROJECT_SETTINGS,
  uiLibrary = {},
  animGraphs,
  spritePayloads,
  onClose,
}: PlayOverlayProps) {
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
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [trace, setTrace] = useState<TracePayload | null>(null);
  const [overlaySize, setOverlaySize] = useState({ width: 1280, height: 720 });
  const [hiddenWidgetIds, setHiddenWidgetIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [hudInstances, setHudInstances] = useState<PlayHudInstance[]>([]);
  const { entries: printEntries, print } = usePrintRegistry();
  const printRef = useRef(print);
  printRef.current = print;
  const scriptsRef = useRef(scripts);
  scriptsRef.current = scripts;
  const animGraphsRef = useRef(animGraphs);
  animGraphsRef.current = animGraphs;
  const spritePayloadsRef = useRef(spritePayloads);
  spritePayloadsRef.current = spritePayloads;
  const physicsRef = useRef(physics);
  physicsRef.current = physics;
  const sceneRef = useRef({ sceneAssetGuid, scene });
  sceneRef.current = { sceneAssetGuid, scene };
  const initialFrameCapRef = useRef(frameCap);
  const initialPlayPreviewRef = useRef(playPreview);
  const commands = useMemo(() => playConsoleCommands(scripts ?? []), [scripts]);

  useEffect(() => {
    const overlay = overlayRef.current;
    const canvas = canvasRef.current;
    if (!overlay || !canvas) return;
    applyPlayPreviewCanvasLayout({
      overlay,
      canvas,
      ...initialPlayPreviewRef.current,
    });
    setOverlaySize({
      width: overlay.clientWidth || 1280,
      height: overlay.clientHeight || 720,
    });
    const session = startPlaySession({
      canvas,
      sharedEngine,
      injectFixtureThrow,
      scripts: scriptsRef.current,
      physics: physicsRef.current,
      sceneAssetGuid: sceneRef.current.sceneAssetGuid,
      scene: sceneRef.current.scene,
      frameCap: initialFrameCapRef.current,
      animGraphs: animGraphsRef.current,
      spritePayloads: spritePayloadsRef.current,
      onUiSetVisible: (widgetId, visible) => {
        setHiddenWidgetIds((prev) => {
          const next = new Set(prev);
          if (visible) next.delete(widgetId);
          else next.add(widgetId);
          return next;
        });
      },
      onUiApply: (instanceId, assetGuid) => {
        setHudInstances((prev) =>
          applyPlayHudInstance(prev, instanceId, assetGuid),
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
    });
    sessionRef.current = session;
    const resizePlayIfSized = () => {
      if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
        session.handle.resize();
      }
    };
    resizePlayIfSized();
    const resizeObserver = new ResizeObserver(() => {
      applyPlayPreviewCanvasLayout({
        overlay,
        canvas,
        ...initialPlayPreviewRef.current,
      });
      setOverlaySize({
        width: overlay.clientWidth || 1280,
        height: overlay.clientHeight || 720,
      });
      resizePlayIfSized();
    });
    resizeObserver.observe(overlay);
    const detachLifecycle = attachLifecyclePause((paused) => {
      sessionRef.current?.setPaused(paused);
    });
    const movePoll = window.setInterval(() => {
      const current = sessionRef.current;
      setMoveX(current?.lastMoveX() ?? null);
      setActorGuids([...(current?.spawnedActorGuids() ?? [])]);
      if (current) {
        setMemoryBytes(current.accountedBytes());
        const counts = current.liveObjectCounts();
        setMeshCount(counts.meshes);
        setTextureCount(counts.textures);
        setDraws(current.drawCalls());
        setBridgeRate(current.bridgeMessagesPerSec());
        const recorded = current.lastTrace();
        if (recorded) setTrace(recorded);
      }
    }, 200);
    return () => {
      resizeObserver.disconnect();
      window.clearInterval(movePoll);
      detachLifecycle();
      if (sessionRef.current) {
        sessionRef.current.stop();
        sessionRef.current = null;
      }
    };
  }, [sharedEngine, injectFixtureThrow]);

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
    >
      <div className="pointer-events-none absolute left-3 top-3 z-10">
        <StatsHud
          fps={fps}
          scriptMs={scriptMs}
          physicsMs={physicsMs}
          memoryBytes={memoryBytes}
          meshCount={meshCount}
          textureCount={textureCount}
          draws={draws}
          bridgeMessagesPerSec={bridgeRate}
        />
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
      </div>
      <div className="absolute right-3 top-3 z-10 flex items-center gap-2">
        <Button
          size="touch-icon"
          variant="secondary"
          data-testid="play-console-open"
          aria-label="Open Console"
          onClick={() => setConsoleOpen(true)}
        >
          <TerminalIcon />
        </Button>
        <Button
          size="touch-icon"
          variant="secondary"
          data-testid="play-overlay-close"
          aria-label="Stop Play"
          onClick={() => {
            const result = sessionRef.current?.stop() ?? emptyPlayResult();
            sessionRef.current = null;
            onClose(result);
          }}
        >
          <XIcon />
        </Button>
      </div>
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
        width={overlaySize.width}
        height={overlaySize.height}
        hiddenWidgetIds={hiddenWidgetIds}
        onTouchAxis={(controlId, value) =>
          sessionRef.current?.pushTouchAxis(controlId, value)
        }
      />
      <PrintOverlay entries={printEntries} />
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
      <DebugConsole
        open={consoleOpen}
        onOpenChange={setConsoleOpen}
        commands={commands}
        onExecute={(line) =>
          sessionRef.current?.executeConsoleCommand(line) ??
          Promise.resolve({ success: false, output: "not playing" })
        }
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
